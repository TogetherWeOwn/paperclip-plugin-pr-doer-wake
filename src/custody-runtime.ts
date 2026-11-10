import { createHash } from "node:crypto";
import { retryableBeforeQueue } from "./native-wake.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { CiGithubCache } from "./ci-github.js";
import { workspaceRepo, UUID } from "./ci-config.js";
import { parseCustodyConfig, type CustodyConfig } from "./custody-config.js";
import { CustodyAppAuth } from "./custody-auth.js";
import { CustodyGithub, type CustodyPull } from "./custody-github.js";
import { loadCustodyCards, type CustodyCard } from "./custody-reader.js";
import { CUSTODY_ORIGIN, DAY, custodyTriggers, latestDisposition, mapCustodyCard, prReference, prUrl, type CustodyRegistration, type Trigger } from "./custody-policy.js";

export const CUSTODY_LIMITS = { effects: 15, requests: 1_200, hostReads: 20_000, tickMs: 240_000, receipts: 20_000, prs: 10_000, audits: 1_000 } as const;
type Receipt = { at: number; turn?: number; status: "pending" | "attempting" | "woken" | "unconfirmed" | "cleared"; phase?: "create" | "wake"; issueId?: string; childId?: string };
function delivered(receipt: Receipt): boolean { return receipt.status === "woken"; }
interface InventoryRow { pr: string; state: string; cardId: string | null; mapping: string; triggers: string[]; unknown?: boolean }
interface Audit { at: number; operation: string; outcome: string; key?: string }
interface Ledger {
  version: 1;
  receipts: Record<string, Receipt>;
  cursors: Record<string, number>;
  attempted: Record<string, number>;
  activityAfter: Record<string, number>;
  dispatchSequence: number;
  heads: Record<string, { sha: string; at: number | null; provenance?: "seeded" | "warmup"; floor?: number }>;
  dispositions: Record<string, number>;
  audits: Audit[];
  report: { at: number; complete: boolean; rows: InventoryRow[]; unknown: string[]; effects: number };
}
const empty = (now: number): Ledger => ({ version: 1, receipts: {}, cursors: {}, attempted: {}, activityAfter: {}, dispatchSequence: 0, heads: {}, dispositions: {}, audits: [], report: { at: now, complete: false, rows: [], unknown: [], effects: 0 } });

/** One host-managed worker; coalesce overlapping hourly/manual runs. No registration or LLM tool surface. */
export class CustodyRuntime {
  private running = false;
  private caches = new Map<string, CiGithubCache>();
  // Scheduled jobs run with no invocation company scope, so the company-less
  // ctx.config.get() the host gate rejects is unusable here. The host delivers
  // the stored company config via onConfigChanged; capture custodyCompanyId
  // from that delivery and read config explicitly with it.
  private custodyCompanyId: string | null = null;
  constructor(private readonly ctx: PluginContext, private readonly now: () => number = Date.now) {}

  setCustodyCompanyId(companyId: string | null): void {
    this.custodyCompanyId = companyId && UUID.test(companyId) ? companyId.toLowerCase() : null;
  }

  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try { await this.tick(); }
    finally { this.running = false; }
  }

  private async tick(): Promise<void> {
    // Fail closed without a captured company: never issue a company-less
    // config.get, which the installed host rejects during scheduled jobs.
    if (!this.custodyCompanyId) {
      this.ctx.logger.info("pr-custody: no company config delivered; skipping tick");
      return;
    }
    const raw = await this.ctx.config.get(this.custodyCompanyId);
    const config = parseCustodyConfig(raw);
    if (!config) return;
    const key = { scopeKind: "company" as const, scopeId: config.companyId, namespace: "pr-custody-v1", stateKey: `${config.org}:${config.dryRun ? "dry" : "live"}` };
    const stored = await this.ctx.state.get(key) as Ledger | null;
    if (stored && (stored.version !== 1 || !stored.receipts || !stored.cursors || !stored.attempted || !stored.heads || !stored.dispositions || !Array.isArray(stored.audits))) throw new Error("invalid_custody_ledger");
    const ledger = stored ?? empty(this.now());
    ledger.activityAfter ??= {};
    ledger.dispatchSequence ??= 0;
    for (const receipt of Object.values(ledger.receipts)) if (receipt.status === "attempting") receipt.status = "unconfirmed";
    ledger.report = { at: this.now(), complete: false, rows: [], unknown: [], effects: 0 };
    const started = this.now();
    let reads = 0;
    let dispatching = false;
    let dispatchReceipt: Receipt | undefined;
    const guard = () => { if (++reads > CUSTODY_LIMITS.hostReads || this.now() - started >= CUSTODY_LIMITS.tickMs) throw new Error("custody_tick_budget"); };
    const audit = (operation: string, outcome: string, effectKey?: string) => {
      ledger.audits.push({ at: this.now(), operation, outcome, ...(effectKey ? { key: effectKey } : {}) });
      ledger.audits = ledger.audits.filter((a) => this.now() - a.at < 30 * DAY).slice(-CUSTODY_LIMITS.audits);
    };
    const save = () => this.ctx.state.set(key, ledger);
    // Admitted preflight yields durably even if it refuses before any native mutation.
    const admitDispatch = async (receipt: Receipt) => {
      guard();
      receipt.turn = ++ledger.dispatchSequence;
      await save();
    };
    // Each trigger spends one slot at its first native mutation, including ambiguous attempts.
    const effectSlot = () => {
      let spent = false;
      return () => {
        if (spent) return;
        if (ledger.report.effects >= CUSTODY_LIMITS.effects) throw new Error("effect_budget");
        ledger.report.effects++;
        spent = true;
      };
    };
    const archiveKey = (kind: "receipt" | "disposition", id: string) => ({ ...key, stateKey: `${key.stateKey}:${kind}:${createHash("sha256").update(id).digest("hex")}` });
    const archived = async (kind: "receipt" | "disposition", id: string): Promise<Receipt | number | null> => {
      guard();
      const entry = await this.ctx.state.get(archiveKey(kind, id)) as { version: number; key: string; value: Receipt | number } | null;
      if (!entry) return null;
      if (entry.version !== 1 || entry.key !== id || (kind === "disposition"
        ? typeof entry.value !== "number" || !Number.isFinite(entry.value)
        : typeof entry.value !== "object" || entry.value === null || !["woken", "cleared"].includes(entry.value.status))) throw new Error("invalid_custody_archive");
      return entry.value;
    };
    // Write through before evicting hot history. Archives are exact-key tombstones, never TTLs.
    const compact = async (kind: "receipt" | "disposition", entries: Record<string, Receipt | number>) => {
      if (Object.keys(entries).length < CUSTODY_LIMITS.receipts - 128) return;
      let moved = 0;
      for (const [id, value] of Object.entries(entries)) {
        if (typeof value !== "number" && !["woken", "cleared"].includes(value.status)) continue;
        if (await archived(kind, id) === null) {
          guard();
          await this.ctx.state.set(archiveKey(kind, id), { version: 1, key: id, value });
        }
        delete entries[id];
        if (++moved >= 128) break;
      }
    };
    const unknown = (scope: string) => { if (!ledger.report.unknown.includes(scope)) ledger.report.unknown.push(scope); };
    try {
      guard();
      const current = parseCustodyConfig(await this.ctx.config.get(config.companyId));
      if (!current || JSON.stringify(current) !== JSON.stringify(config) || config.closedSince > this.now()) throw new Error("custody_configuration_changed");
      audit("inventory", "intent");
      await save();
      await compact("receipt", ledger.receipts);
      await compact("disposition", ledger.dispositions);
      await save();
      const cards = await loadCustodyCards(this.ctx, config.companyId, guard);
      const reposByProject = new Map<string, Set<string>>();
      for (const projectId of new Set(cards.map((c) => c.projectId).filter((id): id is string => id !== null))) {
        guard();
        const project = await this.ctx.projects.get(projectId, config.companyId);
        if (!project || project.companyId !== config.companyId || project.id !== projectId) throw new Error("invalid_project");
        guard();
        const workspaces = await this.ctx.projects.listWorkspaces(projectId, config.companyId);
        if (!Array.isArray(workspaces)) throw new Error("invalid_project_workspaces");
        const repos = new Set<string>();
        for (const workspace of workspaces) {
          if (workspace.projectId !== projectId) throw new Error("cross_project_workspace");
          const repo = workspaceRepo(workspace.repoUrl);
          if (repo) repos.add(repo);
        }
        reposByProject.set(projectId, repos);
      }
      guard();
      const ci = await this.ctx.state.get({ scopeKind: "instance", namespace: "ci-wake-v1", stateKey: "ledger" }) as { version: number; waits: CustodyRegistration[] } | null;
      if (ci && (ci.version !== 1 || !Array.isArray(ci.waits))) throw new Error("invalid_ci_ledger");
      const registrations = ci?.waits ?? [];
      const app = config.githubApp;
      const cacheKey = app
        ? `${config.companyId}:app:${app.appId}:${app.installationId}`
        : `${config.companyId}:${config.tokenRef!.secretId}:${config.tokenRef!.version ?? "latest"}`;
      if (!this.caches.has(cacheKey)) {
        if (this.caches.size >= 8) this.caches.delete(this.caches.keys().next().value!);
        this.caches.set(cacheKey, new CiGithubCache({ maxCacheEntries: 512, maxCacheBytes: 16 * 1024 * 1024 }));
      }
      guard();
      // App mode mints a short-lived read-only installation token per operation
      // and refuses any non-read permission; the key is resolved only at call time.
      const credential: string | CustodyAppAuth = app
        ? new CustodyAppAuth({ appId: app.appId, installationId: app.installationId, org: config.org, now: this.now, cycleMs: CUSTODY_LIMITS.tickMs,
            resolvePrivateKey: () => this.ctx.secrets.resolve(app.privateKeySecretRef, { companyId: config.companyId, configPath: "githubAppPrivateKeySecretRef" }) })
        : await this.ctx.secrets.resolve(config.tokenRef!, { companyId: config.companyId, configPath: "githubTokenSecretRef" });
      // Reserve discovery capacity inside the client's admission gate, before its sole counter advances.
      const inventoryAvailable = () => github.requestCount < CUSTODY_LIMITS.requests - 100 && this.now() - started < CUSTODY_LIMITS.tickMs - 30_000;
      const github: CustodyGithub = new CustodyGithub((url, init) => this.ctx.http.fetch(url, init), credential, {
        now: this.now, cache: this.caches.get(cacheKey)!, maxRequests: CUSTODY_LIMITS.requests, maxPages: 100,
        beforeRequest: () => {
          guard();
          if (!dispatching && !inventoryAvailable()) throw new Error("custody_request_budget");
        },
        onRequestAdmitted: async () => {
          if (dispatchReceipt) {
            const receipt = dispatchReceipt;
            dispatchReceipt = undefined; // A conditional retry belongs to the same scheduling turn.
            await admitDispatch(receipt);
          }
          guard();
        },
      });
      const repos = await github.repositories(config.org);
      const monitored = new Set(repos);
      for (const repo of Object.keys(ledger.activityAfter)) if (!monitored.has(repo)) delete ledger.activityAfter[repo];
      for (const ref of Object.keys(ledger.heads)) if (!monitored.has(ref.split("#")[0]!)) delete ledger.heads[ref];
      const summaries = new Set<string>();
      const pending: Array<{ pr: CustodyPull; card: CustodyCard; trigger: Trigger; repo: string }> = [];
      const scanned = new Map<string, number>();
      const summaryClosures = new Set<string>();
      const holdClosure = (repo: string, trigger: Trigger) => { if (trigger.kind === "closed") scanned.delete(repo); };
      const holdSummaryClosures = () => { for (const repo of summaryClosures) scanned.delete(repo); };
      for (const repo of repos.sort((a, b) => (ledger.attempted[a] ?? 0) - (ledger.attempted[b] ?? 0))) {
        try {
          if (!inventoryAvailable()) throw new Error("inventory_budget");
          ledger.attempted[repo] = this.now();
          // GitHub REST timestamps have second precision; retain inclusive same-second overlap.
          const until = Math.floor(this.now() / 1000) * 1000;
          const open = await github.pulls(repo, "open");
          const closed = await github.pulls(repo, "closed", ledger.cursors[repo] ?? config.closedSince);
          if (open.some((p) => closed.some((c) => p.number === c.number))) throw new Error("contradictory_inventory");
          // A complete open snapshot proves absence. A reopened PR is
          // re-observed as a first observation and seeded from head-bound
          // evidence, so an already-idle reopened PR can trigger on discovery.
          const active = new Set(open.map(prReference));
          for (const ref of Object.keys(ledger.heads)) if (ref.startsWith(`${repo}#`) && !active.has(ref)) delete ledger.heads[ref];
          let complete = true;
          // Rotate expensive evidence reads independently of REST's stable updated-descending order.
          const ordered = [...open, ...closed].sort((a, b) => a.number - b.number);
          const next = ordered.findIndex((pr) => pr.number > (ledger.activityAfter[repo] ?? 0));
          const start = next < 0 ? 0 : next;
          for (const pr of [...ordered.slice(start), ...ordered.slice(0, start)]) {
            if (ledger.report.rows.length >= CUSTODY_LIMITS.prs) throw new Error("custody_inventory_capacity");
            const mapping = mapCustodyCard(pr, cards, registrations, reposByProject, config.companyId);
            const row: InventoryRow = { pr: prReference(pr), state: pr.state, cardId: mapping.card?.id ?? null, mapping: mapping.source, triggers: [] };
            ledger.report.rows.push(row);
            if (pr.authorIsBot || !mapping.card) {
              summaries.add(`${prReference(pr)} ${pr.state} ${pr.authorIsBot ? "bot" : mapping.candidates.length > 1 ? "ambiguous" : "unmapped"}`);
              if (pr.state === "closed") summaryClosures.add(repo);
              continue;
            }
            let owner: CustodyCard;
            try { owner = await this.dispositionClock(mapping.card, pr, ledger, async (id) => await archived("disposition", id) as number | null); }
            catch { if (pr.state === "closed") complete = false; row.unknown = true; unknown(prReference(pr)); continue; }
            let activity: number | null = null;
            let closure: string[] | null = null;
            try {
              if (!inventoryAvailable()) throw new Error("inventory_budget");
              ledger.activityAfter[repo] = pr.number;
              if (pr.state === "open") {
                const ref = prReference(pr);
                let head = ledger.heads[ref];
                if (!head || head.sha !== pr.headSha) {
                  if (!head && Object.keys(ledger.heads).length >= CUSTODY_LIMITS.prs) throw new Error("head_capacity");
                  // Seed only a first observation from head-bound evidence
                  // (head suite, review on the head commit). No evidence keeps
                  // the head UNKNOWN for idle purposes instead of fabricating
                  // an epoch from arrival time; later genuine evidence is
                  // retried each tick below. A changed SHA (e.g. a force-push
                  // revert to an older head) became current now and must not
                  // inherit stale evidence as its idle epoch. Provenance is
                  // recorded so a trusted numeric epoch (genuine "seeded"
                  // evidence or an intentional "warmup") is never confused
                  // with a legacy synthesized epoch below.
                  const at = head ? this.now() : await github.seedHead(pr);
                  const provenance = head ? "warmup" as const : at === null ? undefined : "seeded" as const;
                  head = ledger.heads[ref] = { sha: pr.headSha, at, ...(provenance ? { provenance } : {}) };
                } else if (head.at === null || !head.provenance) {
                  // Unproven heads (at=null, or a numeric epoch with no
                  // provenance from a legacy ledger) are (re)seeded from
                  // head-bound evidence every tick. A legacy numeric epoch
                  // may be the old synthesized first-observation fallback
                  // and cannot be trusted for idle; revalidating it here
                  // adopts genuine evidence when it exists (including a
                  // genuine epoch from an older release) and otherwise
                  // downgrades it to UNKNOWN instead of letting it wake.
                  // But a legacy numeric epoch may equally be an
                  // intentional changed-SHA warmup (a force-push revert
                  // records arrival time): adopting older stale evidence
                  // from that SHA would shorten the seven-day warmup into
                  // an early wake, so the legacy timestamp is preserved as
                  // a lower bound and only newer evidence replaces it.
                  // When the intervening tick has no evidence, idle
                  // activity must stay UNKNOWN (at=null) without erasing
                  // that bound: the legacy timestamp is parked in `floor`
                  // and only enforced when evidence later arrives. A null
                  // tick must never discard a live warmup floor, or stale
                  // evidence on the next tick would bypass it.
                  const seeded = await github.seedHead(pr);
                  if (seeded === null) {
                    if (head.at !== null && !head.provenance) head.floor = head.at;
                    head.at = null;
                    delete head.provenance;
                  } else if (head.at === null && head.floor !== undefined) {
                    if (seeded >= head.floor) {
                      head.at = seeded;
                      head.provenance = "seeded";
                    } else {
                      head.at = head.floor;
                      head.provenance = "warmup";
                    }
                    delete head.floor;
                  } else if (head.at === null || seeded >= head.at) {
                    head.at = seeded;
                    head.provenance = "seeded";
                  } else {
                    head.provenance = "warmup";
                  }
                }
                if (head.at === null) {
                  row.unknown = true;
                  unknown(prReference(pr));
                } else {
                  activity = await github.activity(pr, head.at);
                }
              } else if (!pr.merged) closure = await github.closureTexts(pr);
            } catch { if (pr.state === "closed") complete = false; row.unknown = true; unknown(prReference(pr)); }
            // Missing activity cannot erase an independently established terminal-card trigger.
            const triggers = custodyTriggers(pr, owner, activity, closure, this.now());
            row.triggers = triggers.map((t) => t.key);
            for (const trigger of triggers) pending.push({ pr, card: owner, trigger, repo });
          }
          if (complete) scanned.set(repo, until);
        } catch { unknown(repo); }
      }
      // Persist discovery clocks/removals as one batch before any effect can depend on them.
      await save();
      dispatching = true;
      const dailyKey = `pr-custody-summary|${new Date(this.now()).toISOString().slice(0, 10)}`;
      let summaryReceipt = ledger.receipts[dailyKey] ?? null;
      let summaryReadable = true;
      if (summaries.size && !summaryReceipt) {
        try { summaryReceipt = await archived("receipt", dailyKey) as Receipt | null; }
        catch { summaryReadable = false; }
      }
      if (summaries.size && summaryReadable && !summaryReceipt && Object.keys(ledger.receipts).length < CUSTODY_LIMITS.receipts) summaryReceipt = ledger.receipts[dailyKey] = { at: this.now(), status: "pending" };
      const dispatchSummary = async () => {
        const receipt = summaryReceipt;
        if (!receipt) { unknown(summaryReadable ? "receipt_capacity" : "summary_unknown"); holdSummaryClosures(); }
        else if (config.dryRun) {
          if (receipt.status === "pending") {
            audit("summary", "would_create", dailyKey);
            receipt.status = "cleared";
            await save();
          }
        }
        else if (ledger.report.effects >= CUSTODY_LIMITS.effects) { unknown("effect_budget"); holdSummaryClosures(); }
        else try {
          const spend = effectSlot();
          await admitDispatch(receipt);
          await this.confirmConfig(config, guard);
          const lines = new Set([...summaries].map((s) => `- ${s}`));
          if (receipt.childId) {
            guard();
            const previous = await this.ctx.issues.documents.get(receipt.childId, "pr-custody", config.companyId);
            for (const line of previous?.body.split("\n") ?? []) if (line.startsWith("- ")) lines.add(line);
          }
          const body = `# PR custody: unmapped and bot inventory\n\nNo ownership inferred; no automatic close or reopen.\n\n${[...lines].sort().join("\n")}\n`;
          if (body.length > 250_000) throw new Error("summary_capacity");
          const target = await this.child(config, dailyKey, "PR custody: daily unmapped and bot inventory", body, null, guard, audit, save, receipt, spend);
          guard();
          spend();
          await this.ctx.issues.documents.upsert({ issueId: target, companyId: config.companyId, key: "pr-custody", title: "Daily PR custody inventory", format: "markdown", body });
          if (receipt.status === "pending") await this.wake(config, target, config.summaryAgentId, dailyKey, receipt, guard, audit, save);
          if (!delivered(receipt)) { unknown("summary_deferred_or_unconfirmed"); holdSummaryClosures(); }
        } catch { unknown("summary_unknown"); holdSummaryClosures(); }
      };
      // New work joins at this tick's watermark, not ahead of every retry. Persist its
      // place even when the effect cap refuses admission; summaries share the same queue.
      const arrivalTurn = ledger.dispatchSequence;
      const queue: Array<{ item?: typeof pending[number]; key: string; at: number; turn: number }> = pending.map((item) => ({ item, key: item.trigger.key, at: item.trigger.at, turn: ledger.receipts[item.trigger.key]?.turn ?? arrivalTurn }));
      if (summaries.size) queue.push({ key: dailyKey, at: summaryReceipt?.at ?? this.now(), turn: summaryReceipt?.turn ?? arrivalTurn });
      for (const entry of queue.sort((a, b) => a.turn - b.turn || a.at - b.at || a.key.localeCompare(b.key))) {
        if (!entry.item) {
          if (summaryReceipt) summaryReceipt.turn ??= entry.turn;
          await dispatchSummary(); continue;
        }
        const { pr, card, trigger, repo } = entry.item;
        let receipt = ledger.receipts[trigger.key];
        if (!receipt) {
          try { if (await archived("receipt", trigger.key)) continue; }
          catch { unknown(trigger.key); holdClosure(repo, trigger); continue; }
          if (Object.keys(ledger.receipts).length >= CUSTODY_LIMITS.receipts) { unknown("receipt_capacity"); holdClosure(repo, trigger); continue; }
          receipt = ledger.receipts[trigger.key] = { at: this.now(), turn: entry.turn, status: "pending", issueId: card.id };
          await save();
        }
        receipt.turn ??= entry.turn;
        const spend = effectSlot();
        // A fresh disposition acknowledges a terminal trigger; closed rationale remains mandatory on both sides.
        if (trigger.kind === "terminal" && (latestDisposition(card, pr)?.at ?? 0) > receipt.at) receipt.status = "cleared";
        if (receipt.status === "unconfirmed" && receipt.phase === "create") {
          // Reconcile a possibly created child by origin without ever repeating creation.
          try { await this.child(config, trigger.key, "", "", card, guard, audit, save, receipt, spend); }
          catch { /* Ambiguous creation remains a backstop responsibility. */ }
        }
        if (receipt.status === "unconfirmed") { unknown(trigger.key); holdClosure(repo, trigger); continue; }
        if (receipt.status !== "pending") continue;
        if (config.dryRun) {
          audit("wake", "would_wake", trigger.key);
          this.ctx.logger.info("pr-custody: would wake", { key: trigger.key, issueId: card.id });
          receipt.status = "cleared";
          await save();
          continue;
        }
        if (ledger.report.effects >= CUSTODY_LIMITS.effects) { holdClosure(repo, trigger); unknown("effect_budget"); continue; }
        try {
          // Only the admitted transport advances the turn; inner budget/backoff refusals keep priority.
          await this.confirmConfig(config, guard);
          dispatchReceipt = receipt;
          let currentPr;
          try { currentPr = await github.pull(pr.repo, pr.number); }
          finally { dispatchReceipt = undefined; }
          if (currentPr.headSha !== pr.headSha || currentPr.state !== pr.state || currentPr.merged !== pr.merged) throw new Error("pr_changed");
          guard();
          const fresh = await this.ctx.issues.get(card.id, config.companyId);
          if (!fresh || fresh.companyId !== config.companyId || fresh.projectId !== card.projectId || fresh.status !== card.status || fresh.assigneeAgentId !== card.assigneeAgentId || fresh.assigneeUserId !== card.assigneeUserId) throw new Error("card_changed");
          guard();
          const relations = await this.ctx.issues.relations.get(card.id, config.companyId);
          const eligible = ["todo", "in_progress", "in_review"].includes(fresh.status) && fresh.assigneeAgentId && !fresh.assigneeUserId && !relations.blockedBy.some((b) => b.status !== "done");
          let target = card.id;
          if (!eligible) {
            const child = await this.child(config, trigger.key, `PR disposition: ${prReference(pr)} (${trigger.kind})`, this.evidence(pr, trigger), card, guard, audit, save, receipt, spend);
            target = child;
          }
          guard();
          const previous = await this.ctx.issues.documents.get(target, "pr-custody", config.companyId);
          const evidence = previous?.body.includes(`Key: ${trigger.key}\n`) ? previous.body : `${previous?.body ?? ""}\n${this.evidence(pr, trigger)}`;
          if (evidence.length > 250_000) throw new Error("evidence_capacity");
          guard();
          spend();
          await this.ctx.issues.documents.upsert({ issueId: target, companyId: config.companyId, key: "pr-custody", title: "PR custody evidence", format: "markdown", body: evidence });
          await this.wake(config, target, card.assigneeAgentId ?? config.summaryAgentId, trigger.key, receipt, guard, audit, save);
          if (!delivered(receipt)) { holdClosure(repo, trigger); unknown(prReference(pr)); }
        } catch { holdClosure(repo, trigger); unknown(prReference(pr)); audit("dispatch", "unknown", trigger.key); }
      }
      for (const [repo, until] of scanned) ledger.cursors[repo] = until;
      ledger.report.complete = ledger.report.unknown.length === 0;
      audit("inventory", ledger.report.complete ? "complete" : "unknown");
      await save();
    } catch {
      unknown("inventory");
      audit("inventory", "unknown");
      await save();
    }
    this.ctx.logger.info("pr-custody: inventory", { complete: ledger.report.complete, prs: ledger.report.rows.length, unknown: ledger.report.unknown.length, effects: ledger.report.effects, dryRun: config.dryRun });
  }

  private async dispositionClock(card: CustodyCard, pr: CustodyPull, ledger: Ledger, archived: (id: string) => Promise<number | null>): Promise<CustodyCard> {
    const texts: CustodyCard["texts"] = [];
    for (const text of card.texts) for (const line of text.body.split(/\r?\n/)) {
      const entry = { ...text, body: line };
      if (latestDisposition({ ...card, texts: [entry] }, pr)) {
        const key = createHash("sha256").update(JSON.stringify([card.id, text.id ?? "legacy", line])).digest("hex");
        let at = ledger.dispositions[key] ?? await archived(key);
        if (at === null) {
          if (Object.keys(ledger.dispositions).length >= CUSTODY_LIMITS.receipts) throw new Error("disposition_capacity");
          at = ledger.dispositions[key] = Math.min(text.at, this.now());
        }
        // Generic card/document timestamps cannot refresh an unchanged directive, even after compaction.
        entry.at = at;
      }
      texts.push(entry);
    }
    return { ...card, texts };
  }

  private async confirmConfig(expected: CustodyConfig, guard: () => void): Promise<void> {
    guard();
    const current = parseCustodyConfig(await this.ctx.config.get(expected.companyId));
    if (!current || JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("custody_configuration_changed");
  }

  private evidence(pr: CustodyPull, trigger: Trigger): string {
    return `# PR disposition due\n\nPR: ${prUrl(pr)}\nHead: ${pr.headSha}\nTrigger: ${trigger.kind}\nEpoch: ${trigger.epoch}\nKey: ${trigger.key}\n\nChoose finish, rework, defer or close using current evidence and existing review/release gates. Idle age is a trigger, never a verdict. Preserve valid supersession and unique work. Record a PR-specific disposition on the source card; closure rationale belongs on both the card and PR. This job never closes, reopens or merges PRs.\n`;
  }

  private async child(config: CustodyConfig, originId: string, title: string, body: string, card: CustodyCard | null, guard: () => void, audit: (operation: string, outcome: string, key?: string) => void, save: () => Promise<void>, receipt: Receipt, spend: () => void): Promise<string> {
    if (receipt.childId) return receipt.childId;
    guard();
    const existing = await this.ctx.issues.list({ companyId: config.companyId, originKind: CUSTODY_ORIGIN, originId, includePluginOperations: true, limit: 2 });
    if (existing.length > 1 || existing.some((c) => c.companyId !== config.companyId || c.originKind !== CUSTODY_ORIGIN || c.originId !== originId)) throw new Error("ambiguous_origin");
    if (existing[0]) {
      receipt.childId = existing[0].id;
      if (receipt.phase === "create") receipt.status = "pending";
      await save();
      return existing[0].id;
    }
    if (receipt.phase === "create" && receipt.status !== "pending") throw new Error("creation_unconfirmed");
    // Create can have an ambiguous result too. Persist intent and never repeat an unconfirmed creation.
    spend();
    audit("create", "intent", originId);
    receipt.phase = "create";
    receipt.status = "attempting";
    try { await save(); guard(); }
    catch (error) { receipt.status = "pending"; throw error; }
    const created = await this.ctx.issues.create({ companyId: config.companyId, ...(card ? { parentId: card.id } : {}), title, description: body.slice(0, 16_000), status: "todo", priority: "medium", assigneeAgentId: card?.assigneeAgentId ?? config.summaryAgentId, originKind: CUSTODY_ORIGIN, originId });
    if (!created || created.companyId !== config.companyId || !UUID.test(created.id) || created.originId !== originId || created.originKind !== CUSTODY_ORIGIN) throw new Error("invalid_created_card");
    receipt.childId = created.id;
    receipt.status = "pending";
    audit("create", "created", originId);
    await save();
    return created.id;
  }

  private async wake(config: CustodyConfig, target: string, expectedAgent: string, effectKey: string, receipt: Receipt, guard: () => void, audit: (operation: string, outcome: string, key?: string) => void, save: () => Promise<void>): Promise<void> {
    await this.confirmConfig(config, guard);
    guard();
    const current = await this.ctx.issues.get(target, config.companyId);
    if (!current || current.id !== target || current.companyId !== config.companyId || current.assigneeAgentId !== expectedAgent || current.assigneeUserId || !["todo", "in_progress", "in_review"].includes(current.status)) throw new Error("wake_target_changed");
    guard();
    const relations = await this.ctx.issues.relations.get(target, config.companyId);
    if (relations.blockedBy.some((b) => b.status !== "done")) throw new Error("wake_target_blocked");
    receipt.phase = "wake";
    receipt.status = "attempting";
    audit("wake", "intent", effectKey);
    try { await save(); guard(); }
    catch (error) { receipt.status = "pending"; throw error; }
    try {
      const result = await this.ctx.issues.requestWakeup(target, config.companyId, { reason: "pr_disposition_due", contextSource: "plugin.pr-custody", idempotencyKey: effectKey });
      receipt.status = result.queued ? "woken" : "pending";
      audit("wake", result.queued ? "woken" : "host_deferred", effectKey);
    } catch (error) {
      receipt.status = retryableBeforeQueue(error) ? "pending" : "unconfirmed";
      audit("wake", receipt.status === "pending" ? "host_deferred" : "unconfirmed", effectKey);
    }
    await save();
  }
}
