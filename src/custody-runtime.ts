import type { PluginContext } from "@paperclipai/plugin-sdk";
import { CiGithubCache } from "./ci-github.js";
import { workspaceRepo, UUID } from "./ci-config.js";
import { parseCustodyConfig, type CustodyConfig } from "./custody-config.js";
import { CustodyGithub, type CustodyPull } from "./custody-github.js";
import { loadCustodyCards, type CustodyCard } from "./custody-reader.js";
import { CUSTODY_ORIGIN, DAY, custodyTriggers, latestDisposition, mapCustodyCard, prReference, prUrl, type CustodyRegistration, type Trigger } from "./custody-policy.js";

export const CUSTODY_LIMITS = { effects: 15, requests: 1_200, hostReads: 20_000, tickMs: 240_000, receipts: 20_000, prs: 10_000, audits: 1_000 } as const;
type Receipt = { at: number; status: "pending" | "attempting" | "woken" | "unconfirmed" | "cleared"; phase?: "create" | "wake"; issueId?: string; childId?: string };
interface InventoryRow { pr: string; state: string; cardId: string | null; mapping: string; triggers: string[]; unknown?: boolean }
interface Audit { at: number; operation: string; outcome: string; key?: string }
interface Ledger {
  version: 1;
  receipts: Record<string, Receipt>;
  cursors: Record<string, number>;
  attempted: Record<string, number>;
  heads: Record<string, { sha: string; at: number }>;
  audits: Audit[];
  report: { at: number; complete: boolean; rows: InventoryRow[]; unknown: string[]; effects: number };
}
const empty = (now: number): Ledger => ({ version: 1, receipts: {}, cursors: {}, attempted: {}, heads: {}, audits: [], report: { at: now, complete: false, rows: [], unknown: [], effects: 0 } });

/** One host-managed worker; coalesce overlapping hourly/manual runs. No registration or LLM tool surface. */
export class CustodyRuntime {
  private running = false;
  private caches = new Map<string, CiGithubCache>();
  constructor(private readonly ctx: PluginContext, private readonly now: () => number = Date.now) {}

  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try { await this.tick(); }
    finally { this.running = false; }
  }

  private async tick(): Promise<void> {
    const raw = await this.ctx.config.get();
    const config = parseCustodyConfig(raw);
    if (!config) return;
    const key = { scopeKind: "company" as const, scopeId: config.companyId, namespace: "pr-custody-v1", stateKey: `${config.org}:${config.dryRun ? "dry" : "live"}` };
    const stored = await this.ctx.state.get(key) as Ledger | null;
    if (stored && (stored.version !== 1 || !stored.receipts || !stored.cursors || !stored.attempted || !stored.heads || !Array.isArray(stored.audits))) throw new Error("invalid_custody_ledger");
    const ledger = stored ?? empty(this.now());
    for (const receipt of Object.values(ledger.receipts)) if (receipt.status === "attempting") receipt.status = "unconfirmed";
    ledger.report = { at: this.now(), complete: false, rows: [], unknown: [], effects: 0 };
    const started = this.now();
    let requests = 0;
    let reads = 0;
    const guard = () => { if (++reads > CUSTODY_LIMITS.hostReads || this.now() - started >= CUSTODY_LIMITS.tickMs) throw new Error("custody_tick_budget"); };
    const audit = (operation: string, outcome: string, effectKey?: string) => {
      ledger.audits.push({ at: this.now(), operation, outcome, ...(effectKey ? { key: effectKey } : {}) });
      ledger.audits = ledger.audits.filter((a) => this.now() - a.at < 30 * DAY).slice(-CUSTODY_LIMITS.audits);
    };
    const save = () => this.ctx.state.set(key, ledger);
    const unknown = (scope: string) => { if (!ledger.report.unknown.includes(scope)) ledger.report.unknown.push(scope); };
    try {
      guard();
      const current = parseCustodyConfig(await this.ctx.config.get(config.companyId));
      if (!current || JSON.stringify(current) !== JSON.stringify(config) || config.closedSince > this.now()) throw new Error("custody_configuration_changed");
      audit("inventory", "intent");
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
      const cacheKey = `${config.companyId}:${config.tokenRef.secretId}:${config.tokenRef.version ?? "latest"}`;
      if (!this.caches.has(cacheKey)) {
        if (this.caches.size >= 8) this.caches.delete(this.caches.keys().next().value!);
        this.caches.set(cacheKey, new CiGithubCache({ maxCacheEntries: 512, maxCacheBytes: 16 * 1024 * 1024 }));
      }
      guard();
      const token = await this.ctx.secrets.resolve(config.tokenRef, { companyId: config.companyId, configPath: "githubTokenSecretRef" });
      const github = new CustodyGithub(async (url, init) => {
        guard();
        if (++requests > CUSTODY_LIMITS.requests) throw new Error("custody_request_budget");
        return this.ctx.http.fetch(url, init);
      }, token, { now: this.now, cache: this.caches.get(cacheKey)!, maxRequests: CUSTODY_LIMITS.requests, maxPages: 100 });
      const repos = await github.repositories(config.org);
      const summaries = new Set<string>();
      const pending: Array<{ pr: CustodyPull; card: CustodyCard; trigger: Trigger; repo: string }> = [];
      const scanned = new Map<string, number>();
      for (const repo of repos.sort((a, b) => (ledger.attempted[a] ?? 0) - (ledger.attempted[b] ?? 0))) {
        ledger.attempted[repo] = this.now();
        try {
          const until = this.now();
          const open = await github.pulls(repo, "open");
          const closed = await github.pulls(repo, "closed", ledger.cursors[repo] ?? config.closedSince);
          if (open.some((p) => closed.some((c) => p.number === c.number))) throw new Error("contradictory_inventory");
          let complete = true;
          for (const pr of [...open, ...closed]) {
            if (ledger.report.rows.length >= CUSTODY_LIMITS.prs) throw new Error("custody_inventory_capacity");
            const mapping = mapCustodyCard(pr, cards, registrations, reposByProject, config.companyId);
            const row: InventoryRow = { pr: prReference(pr), state: pr.state, cardId: mapping.card?.id ?? null, mapping: mapping.source, triggers: [] };
            ledger.report.rows.push(row);
            if (pr.authorIsBot || !mapping.card) {
              summaries.add(`${prReference(pr)} ${pr.state} ${pr.authorIsBot ? "bot" : mapping.candidates.length > 1 ? "ambiguous" : "unmapped"}`);
              continue;
            }
            let activity: number | null = null;
            let closure: string[] | null = null;
            try {
              if (pr.state === "open") {
                const ref = prReference(pr);
                let head = ledger.heads[ref];
                if (!head || head.sha !== pr.headSha) {
                  if (!head && Object.keys(ledger.heads).length >= CUSTODY_LIMITS.prs) throw new Error("head_capacity");
                  head = ledger.heads[ref] = { sha: pr.headSha, at: this.now() };
                  await save();
                }
                activity = await github.activity(pr, head.at);
              } else if (!pr.merged) closure = await github.closureTexts(pr);
            } catch { complete = false; row.unknown = true; unknown(prReference(pr)); }
            // Missing activity cannot erase an independently established terminal-card trigger.
            const triggers = custodyTriggers(pr, mapping.card, activity, closure, this.now());
            row.triggers = triggers.map((t) => t.key);
            for (const trigger of triggers) pending.push({ pr, card: mapping.card, trigger, repo });
          }
          if (complete) scanned.set(repo, until);
        } catch { unknown(repo); }
      }
      // Oldest first, across repositories. No cursor advances past an undispatched closure.
      for (const item of pending.sort((a, b) => a.trigger.at - b.trigger.at || a.trigger.key.localeCompare(b.trigger.key))) {
        const { pr, card, trigger, repo } = item;
        let receipt = ledger.receipts[trigger.key];
        if (!receipt) {
          if (Object.keys(ledger.receipts).length >= CUSTODY_LIMITS.receipts) { unknown("receipt_capacity"); scanned.delete(repo); continue; }
          receipt = ledger.receipts[trigger.key] = { at: this.now(), status: "pending", issueId: card.id };
          await save();
        }
        // A fresh disposition acknowledges a terminal trigger; closed rationale remains mandatory on both sides.
        if (trigger.kind === "terminal" && (latestDisposition(card, pr)?.at ?? 0) > receipt.at) receipt.status = "cleared";
        if (receipt.status === "unconfirmed" && receipt.phase === "create") {
          // Reconcile a possibly created child by origin without ever repeating creation.
          try { await this.child(config, trigger.key, "", "", card, guard, audit, save, receipt); }
          catch { /* Ambiguous creation remains a backstop responsibility. */ }
        }
        if (receipt.status === "unconfirmed") { unknown(trigger.key); scanned.delete(repo); continue; }
        if (receipt.status !== "pending") continue;
        if (config.dryRun) {
          audit("wake", "would_wake", trigger.key);
          this.ctx.logger.info("pr-custody: would wake", { key: trigger.key, issueId: card.id });
          continue;
        }
        if (ledger.report.effects >= CUSTODY_LIMITS.effects) { scanned.delete(repo); unknown("effect_budget"); continue; }
        // A creation that fails ambiguously still spends its run's effect slot.
        ledger.report.effects++;
        try {
          await this.confirmConfig(config, guard);
          const currentPr = await github.pull(pr.repo, pr.number);
          if (currentPr.headSha !== pr.headSha || currentPr.state !== pr.state || currentPr.merged !== pr.merged) throw new Error("pr_changed");
          guard();
          const fresh = await this.ctx.issues.get(card.id, config.companyId);
          if (!fresh || fresh.companyId !== config.companyId || fresh.projectId !== card.projectId || fresh.status !== card.status || fresh.assigneeAgentId !== card.assigneeAgentId || fresh.assigneeUserId !== card.assigneeUserId) throw new Error("card_changed");
          guard();
          const relations = await this.ctx.issues.relations.get(card.id, config.companyId);
          const eligible = ["todo", "in_progress", "in_review"].includes(fresh.status) && fresh.assigneeAgentId && !fresh.assigneeUserId && !relations.blockedBy.some((b) => b.status !== "done");
          let target = card.id;
          if (!eligible) {
            const child = await this.child(config, trigger.key, `PR disposition: ${prReference(pr)} (${trigger.kind})`, this.evidence(pr, trigger), card, guard, audit, save, receipt);
            target = child;
          }
          guard();
          const previous = await this.ctx.issues.documents.get(target, "pr-custody", config.companyId);
          const evidence = previous?.body.includes(`Key: ${trigger.key}\n`) ? previous.body : `${previous?.body ?? ""}\n${this.evidence(pr, trigger)}`;
          if (evidence.length > 250_000) throw new Error("evidence_capacity");
          guard();
          await this.ctx.issues.documents.upsert({ issueId: target, companyId: config.companyId, key: "pr-custody", title: "PR custody evidence", format: "markdown", body: evidence });
          await this.wake(config, target, trigger.key, receipt, ledger, guard, audit, save);
          if (receipt.status === "pending") { scanned.delete(repo); unknown(prReference(pr)); }
        } catch { scanned.delete(repo); unknown(prReference(pr)); audit("dispatch", "unknown", trigger.key); }
      }
      if (summaries.size) {
        const dailyKey = `pr-custody-summary|${new Date(this.now()).toISOString().slice(0, 10)}`;
        let receipt = ledger.receipts[dailyKey];
        if (!receipt && Object.keys(ledger.receipts).length < CUSTODY_LIMITS.receipts) receipt = ledger.receipts[dailyKey] = { at: this.now(), status: "pending" };
        if (!receipt) { unknown("receipt_capacity"); scanned.clear(); }
        else if (config.dryRun) audit("summary", "would_create", dailyKey);
        else if (ledger.report.effects >= CUSTODY_LIMITS.effects && receipt.status === "pending") { unknown("effect_budget"); scanned.clear(); }
        else try {
          if (receipt.status === "pending") ledger.report.effects++;
          await this.confirmConfig(config, guard);
          const lines = new Set([...summaries].map((s) => `- ${s}`));
          if (receipt.childId) {
            guard();
            const previous = await this.ctx.issues.documents.get(receipt.childId, "pr-custody", config.companyId);
            for (const line of previous?.body.split("\n") ?? []) if (line.startsWith("- ")) lines.add(line);
          }
          const body = `# PR custody: unmapped and bot inventory\n\nNo ownership inferred; no automatic close or reopen.\n\n${[...lines].sort().join("\n")}\n`;
          if (body.length > 250_000) throw new Error("summary_capacity");
          const target = await this.child(config, dailyKey, "PR custody: daily unmapped and bot inventory", body, null, guard, audit, save, receipt);
          guard();
          await this.ctx.issues.documents.upsert({ issueId: target, companyId: config.companyId, key: "pr-custody", title: "Daily PR custody inventory", format: "markdown", body });
          if (receipt.status === "pending") await this.wake(config, target, dailyKey, receipt, ledger, guard, audit, save);
          if (receipt.status === "pending") { unknown("summary_deferred"); scanned.clear(); }
        } catch { unknown("summary_unknown"); scanned.clear(); }
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

  private async confirmConfig(expected: CustodyConfig, guard: () => void): Promise<void> {
    guard();
    const current = parseCustodyConfig(await this.ctx.config.get(expected.companyId));
    if (!current || JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("custody_configuration_changed");
  }

  private evidence(pr: CustodyPull, trigger: Trigger): string {
    return `# PR disposition due\n\nPR: ${prUrl(pr)}\nHead: ${pr.headSha}\nTrigger: ${trigger.kind}\nEpoch: ${trigger.epoch}\nKey: ${trigger.key}\n\nChoose finish, rework, defer or close using current evidence and existing review/release gates. Idle age is a trigger, never a verdict. Preserve valid supersession and unique work. Record a PR-specific disposition on the source card; closure rationale belongs on both the card and PR. This job never closes, reopens or merges PRs.\n`;
  }

  private async child(config: CustodyConfig, originId: string, title: string, body: string, card: CustodyCard | null, guard: () => void, audit: (operation: string, outcome: string, key?: string) => void, save: () => Promise<void>, receipt: Receipt): Promise<string> {
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
    audit("create", "intent", originId);
    receipt.phase = "create";
    receipt.status = "attempting";
    await save();
    guard();
    const created = await this.ctx.issues.create({ companyId: config.companyId, ...(card ? { parentId: card.id } : {}), title, description: body.slice(0, 16_000), status: "todo", priority: "medium", assigneeAgentId: card?.assigneeAgentId ?? config.summaryAgentId, originKind: CUSTODY_ORIGIN, originId });
    if (!created || created.companyId !== config.companyId || !UUID.test(created.id) || created.originId !== originId || created.originKind !== CUSTODY_ORIGIN) throw new Error("invalid_created_card");
    receipt.childId = created.id;
    receipt.status = "pending";
    audit("create", "created", originId);
    await save();
    return created.id;
  }

  private async wake(config: CustodyConfig, target: string, effectKey: string, receipt: Receipt, ledger: Ledger, guard: () => void, audit: (operation: string, outcome: string, key?: string) => void, save: () => Promise<void>): Promise<void> {
    await this.confirmConfig(config, guard);
    receipt.phase = "wake";
    receipt.status = "attempting";
    audit("wake", "intent", effectKey);
    await save();
    guard();
    try {
      const result = await this.ctx.issues.requestWakeup(target, config.companyId, { reason: "pr_disposition_due", contextSource: "plugin.pr-custody", idempotencyKey: effectKey });
      receipt.status = result.queued ? "woken" : "pending";
      audit("wake", result.queued ? "woken" : "host_deferred", effectKey);
    } catch {
      receipt.status = "unconfirmed";
      audit("wake", "unconfirmed", effectKey);
    }
    await save();
  }
}
