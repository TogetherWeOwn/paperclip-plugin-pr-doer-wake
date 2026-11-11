import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { parseCiConfig, validateCiConfig, UUID, type CiConfig } from "./ci-config.js";
import { CiGithub, CiGithubCache, CiGithubError, GATES_CONTEXT } from "./ci-github.js";
import { CiAppAuth, GATES_PERMISSIONS } from "./ci-auth.js";
import { extractGatesDecision, gatesDescription, type GatesDecision } from "./gates-decision.js";

export const GATES_LIMITS = {
  queue: 1_000,
  drainPerTick: 20,
  audit: 1_000,
  published: 2_000,
  requestsPerTick: 240,
  tickMs: 180_000,
  /** GitHub allows at most 1,000 statuses per SHA; stay under it per repo+SHA. */
  statusCap: 1_000,
  maxAttempts: 20,
  permissionCooldownMs: 60_000,
} as const;

const KEY = { scopeKind: "instance" as const, namespace: "gates-status-v1", stateKey: "ledger" };
const PUBLISHED_RETENTION_MS = 30 * 86_400_000;
const MISSING_PERMISSION_RETENTION_MS = 3_600_000;

interface QueueEntry {
  issueId: string;
  companyId: string;
  enqueuedAt: number;
  attempts: number;
  nextAttemptAt: number;
  /** Missing-permission retries never exhaust: they use this counter, not `attempts`. */
  missingPermissionAttempts?: number;
  /** Shadow-deferred sweeps never exhaust: they use this counter, not `attempts`. */
  shadowAttempts?: number;
}
interface Published {
  repo: string;
  sha: string;
  state: string | null;
  count: number;
  lastPublishedAt: number;
  lastMissingPermissionAt?: number;
  /** Shadow-only record: retained so the shadow→live flip can publish it. Never dedupes live. */
  shadowed?: boolean;
  lastShadowAt?: number;
  /** Authoritative-decision watermark: no decision older than this may republish. */
  watermarkDecidedAtMs?: number;
  watermarkInteractionId?: string;
}
interface Audit {
  at: number;
  operation: string;
  outcome: string;
  companyId?: string;
  issueId?: string;
  repo?: string;
  sha?: string;
  state?: string;
}
interface GatesLedger {
  version: 1;
  queue: QueueEntry[];
  published: Record<string, Published>;
  audits: Audit[];
}
const empty = (): GatesLedger => ({ version: 1, queue: [], published: {}, audits: [] });

function isMissingPermission(error: unknown): boolean {
  // A 403 from the write call, or an App token whose granted set lacks
  // `statuses: write` (mint validation raises `auth`), both fail closed as
  // missing_permission. Everything else is conservatively retryable.
  return error instanceof CiGithubError && ((error.code === "http" && error.status === 403) || error.code === "auth");
}

function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 5), 900_000);
}

/**
 * Totally-ordered gates worker: `issue.updated` events enqueue and drain one
 * card; the `gates-status-sweep` job drains the persisted queue for cards
 * whose events were dropped. No company enumeration: only enqueued issues
 * are ever read.
 */
export class GatesStatusRuntime {
  private lock: Promise<unknown> = Promise.resolve();
  private drainInFlight = false;
  private fullRequested = false;
  private readonly caches = new Map<string, CiGithubCache>();
  private readonly githubBackoffs = new Map<string, { until: number }>();

  constructor(private readonly ctx: PluginContext, private readonly now: () => number = Date.now) {}

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<GatesLedger> {
    const ledger = await this.ctx.state.get(KEY) as GatesLedger | null;
    if (!ledger) return empty();
    if (ledger.version !== 1 || !Array.isArray(ledger.queue) || !ledger.published || typeof ledger.published !== "object" || !Array.isArray(ledger.audits)) throw new Error("invalid_ledger");
    return ledger;
  }

  private async save(ledger: GatesLedger): Promise<void> {
    await this.ctx.state.set(KEY, ledger);
  }

  private audit(ledger: GatesLedger, operation: string, outcome: string, identity: Pick<Audit, "companyId" | "issueId" | "repo" | "sha" | "state"> = {}): void {
    ledger.audits.push({ at: this.now(), operation, outcome, ...identity });
    while (ledger.audits.length > GATES_LIMITS.audit) {
      const routine = ledger.audits.findIndex((entry, index) => index < ledger.audits.length - 1 && entry.operation === "drain" && entry.outcome === "intent");
      ledger.audits.splice(routine < 0 ? 0 : routine, 1);
    }
  }

  private compact(ledger: GatesLedger): void {
    const now = this.now();
    for (const [key, record] of Object.entries(ledger.published)) {
      const published = record.count > 0;
      const at = published ? record.lastPublishedAt : (record.lastShadowAt ?? record.lastMissingPermissionAt ?? 0);
      const retention = published || record.shadowed ? PUBLISHED_RETENTION_MS : MISSING_PERMISSION_RETENTION_MS;
      if (now - at >= retention) delete ledger.published[key];
    }
    const records = Object.entries(ledger.published).sort((a, b) => (a[1].lastPublishedAt || a[1].lastShadowAt || a[1].lastMissingPermissionAt || 0) - (b[1].lastPublishedAt || b[1].lastShadowAt || b[1].lastMissingPermissionAt || 0));
    for (const [key] of records.slice(0, Math.max(records.length - GATES_LIMITS.published, 0))) delete ledger.published[key];
  }

  private async config(companyId: string): Promise<{ config: CiConfig | null; invalid: boolean }> {
    const raw = await this.ctx.config.get(companyId);
    if (validateCiConfig(raw).length) return { config: null, invalid: true };
    return { config: parseCiConfig(raw), invalid: false };
  }

  private async client(companyId: string, config: CiConfig, repo: string, fetch: PluginContext["http"]["fetch"], cycle: Map<string, CiAppAuth>): Promise<CiGithub> {
    const app = config.githubApp;
    const key = app ? `${companyId}:app:${app.appId}:${app.installationId}`
      : `${companyId}:${config.githubTokenSecretRef!.secretId}:${config.githubTokenSecretRef!.version ?? "latest"}`;
    const quota = app ? `app:${app.appId}:${app.installationId}` : `bearer:${key}`;
    for (const [id, entry] of this.githubBackoffs) if (entry.until <= this.now()) this.githubBackoffs.delete(id);
    let backoff = this.githubBackoffs.get(quota);
    if (!backoff) {
      if (this.githubBackoffs.size >= GATES_LIMITS.published) throw new Error("github_backoff_capacity");
      backoff = { until: 0 };
      this.githubBackoffs.set(quota, backoff);
    }
    if (this.now() < backoff.until) throw new Error("github_backoff");
    if (!this.caches.has(key)) {
      if (this.caches.size >= 8) this.caches.delete(this.caches.keys().next().value!);
      this.caches.set(key, new CiGithubCache());
    }
    const cache = this.caches.get(key)!;
    if (this.now() < cache.backoffUntil) throw new Error("github_backoff");
    let credential: string | CiAppAuth;
    if (app) {
      const scope = `${companyId}:${JSON.stringify([app.appId, app.installationId, app.privateKeySecretRef])}:${repo}`;
      if (!cycle.has(scope)) cycle.set(scope, new CiAppAuth({
        appId: app.appId, installationId: app.installationId, repo, now: this.now, permissions: GATES_PERMISSIONS,
        resolvePrivateKey: () => this.ctx.secrets.resolve(app.privateKeySecretRef, { companyId, configPath: "githubAppPrivateKeySecretRef" }),
      }));
      credential = cycle.get(scope)!;
    } else credential = await this.ctx.secrets.resolve(config.githubTokenSecretRef!, { companyId, configPath: "githubTokenSecretRef" });
    return new CiGithub(fetch, credential, { now: this.now, cache, backoff });
  }

  async handleIssueUpdated(event: PluginEvent): Promise<void> {
    if (event.eventType !== "issue.updated" || !event.entityId || !UUID.test(event.entityId) || !UUID.test(event.companyId)) return;
    const issueId = event.entityId.toLowerCase();
    const companyId = event.companyId.toLowerCase();
    // Disabled/invalid publisher: return before any ledger I/O, so the
    // default-disabled configuration costs no state writes per update.
    let cfg: { config: CiConfig | null; invalid: boolean };
    try {
      cfg = await this.config(companyId);
    } catch {
      // A transient config-read failure must not lose the event: persist
      // the issue ID so the sweep retries config reads from the saved
      // entry, instead of losing the decision until another update.
      await this.enqueueIssue(companyId, issueId);
      await this.drain({ companyId, issueId });
      return;
    }
    if (cfg.invalid || !cfg.config!.gatesStatusEnabled || !cfg.config!.releaseManagerAgentId) return;
    await this.enqueueIssue(companyId, issueId);
    await this.drain({ companyId, issueId });
  }

  private async enqueueIssue(companyId: string, issueId: string): Promise<void> {
    await this.serialized(async () => {
      const ledger = await this.load();
      this.compact(ledger);
      const existing = ledger.queue.find((entry) => entry.issueId === issueId && entry.companyId === companyId);
      if (existing) {
        // A fresh update re-checks now even if a prior defer (shadow or
        // missing-permission) backed this entry off; the attempt counters
        // and cooldown/permission checks still apply at apply time.
        if (existing.nextAttemptAt > this.now()) {
          existing.nextAttemptAt = this.now();
          await this.save(ledger);
        }
      } else {
        if (ledger.queue.length >= GATES_LIMITS.queue) {
          this.ctx.logger.warn("gates: queue full, issue.updated dropped", { issueId });
          return;
        }
        ledger.queue.push({ issueId, companyId, enqueuedAt: this.now(), attempts: 0, nextAttemptAt: this.now() });
        this.audit(ledger, "enqueue", "enqueued", { issueId, companyId });
        await this.save(ledger);
      }
    });
  }

  async drain(only?: { companyId: string; issueId: string }): Promise<void> {
    if (this.drainInFlight) {
      this.fullRequested = true;
      return;
    }
    this.drainInFlight = true;
    try {
      await this.serialized(() => this.drainLocked(only));
      if (this.fullRequested) {
        this.fullRequested = false;
        await this.serialized(() => this.drainLocked());
      }
    } finally {
      this.drainInFlight = false;
      this.fullRequested = false;
    }
  }

  private async drainLocked(only?: { companyId: string; issueId: string }): Promise<void> {
    const ledger = await this.load();
    this.compact(ledger);
    const started = this.now();
    let requests = 0;
    const cycle = new Map<string, CiAppAuth>();
    const fetch: PluginContext["http"]["fetch"] = async (url, init) => {
      if (++requests > GATES_LIMITS.requestsPerTick || this.now() - started >= GATES_LIMITS.tickMs) throw new Error("tick_budget");
      return this.ctx.http.fetch(url, init);
    };
    const due = ledger.queue
      .filter((entry) => entry.nextAttemptAt <= this.now() && (!only || entry.companyId === only.companyId && entry.issueId === only.issueId))
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt)
      .slice(0, GATES_LIMITS.drainPerTick);
    // A disabled sweep (gatesStatusEnabled off, queue never fills) must not
    // write a drain/intent audit every tick: no work, no audit, no save.
    if (due.length === 0) return;
    this.audit(ledger, "drain", "intent");
    await this.save(ledger);
    for (const entry of due) {
      if (requests >= GATES_LIMITS.requestsPerTick || this.now() - started >= GATES_LIMITS.tickMs) break;
      const done = await this.processEntry(ledger, entry, fetch, cycle);
      if (done) {
        ledger.queue = ledger.queue.filter((item) => item !== entry);
        await this.save(ledger);
      } else {
        await this.save(ledger);
      }
    }
    await this.save(ledger);
  }

  /** Returns true when the entry should leave the queue. */
  private async processEntry(ledger: GatesLedger, entry: QueueEntry, fetch: PluginContext["http"]["fetch"], cycle: Map<string, CiAppAuth>): Promise<boolean> {
    const identity = { companyId: entry.companyId, issueId: entry.issueId };
    try {
      const { config, invalid } = await this.config(entry.companyId);
      if (invalid) {
        this.audit(ledger, "decision", "skipped_invalid_config", identity);
        return true;
      }
      if (!config!.gatesStatusEnabled || !config!.releaseManagerAgentId) {
        this.audit(ledger, "decision", "skipped_disabled", identity);
        return true;
      }
      const interactions = await this.ctx.issues.listInteractions(entry.issueId, entry.companyId);
      if (!Array.isArray(interactions)) throw new Error("invalid_interactions");
      const decisions: GatesDecision[] = [];
      for (const interaction of interactions) {
        const extraction = extractGatesDecision(interaction, config!.releaseManagerAgentId);
        if ("decision" in extraction) decisions.push(extraction.decision);
      }
      if (!decisions.length) {
        this.audit(ledger, "decision", "no_decision", identity);
        return true;
      }
      // A thread may retain several RM decisions for one repo+SHA with
      // opposite outcomes. Only the authoritative (newest) decision per
      // repo+SHA is applied; host list order must never pick the state.
      // Authoritative = greatest host decision time, interaction id as
      // the deterministic tie-break for equal/missing timestamps.
      const authoritative = new Map<string, GatesDecision>();
      for (const decision of decisions) {
        const key = `${decision.repo}:${decision.sha}`;
        const current = authoritative.get(key);
        if (!current
          || decision.decidedAtMs > current.decidedAtMs
          || (decision.decidedAtMs === current.decidedAtMs
            && (decision.interactionId ?? "") > (current.interactionId ?? ""))) {
          authoritative.set(key, decision);
        }
      }
      let retryable = false;
      let missingPermission = false;
      let shadowDeferred = false;
      for (const decision of authoritative.values()) {
        const outcome = await this.applyDecision(ledger, entry, config!, decision, fetch, cycle);
        if (outcome === "retryable") retryable = true;
        if (outcome === "retryable_missing_permission") missingPermission = true;
        if (outcome === "shadow_deferred") shadowDeferred = true;
      }
      if (!retryable && !missingPermission && !shadowDeferred) return true;
      if (missingPermission) return this.retryMissingPermission(ledger, entry, identity);
      if (retryable) return this.retry(ledger, entry, identity, "retryable");
      return this.retryShadow(ledger, entry, identity);
    } catch {
      return this.retry(ledger, entry, identity, "retryable");
    }
  }

  private retry(ledger: GatesLedger, entry: QueueEntry, identity: { companyId: string; issueId: string }, outcome: string): boolean {
    entry.attempts += 1;
    if (entry.attempts >= GATES_LIMITS.maxAttempts) {
      this.audit(ledger, "decision", "gave_up", identity);
      return true;
    }
    entry.nextAttemptAt = this.now() + backoffMs(entry.attempts);
    this.audit(ledger, "decision", outcome, identity);
    return false;
  }

  /**
   * Missing `statuses: write` is a durable blocked state, not a dying
   * retry: it retries at capped backoff forever (bounded by the queue
   * cap) and never counts toward `maxAttempts`, so a later grant still
   * publishes without needing another issue update.
   */
  private retryMissingPermission(ledger: GatesLedger, entry: QueueEntry, identity: { companyId: string; issueId: string }): boolean {
    entry.missingPermissionAttempts = (entry.missingPermissionAttempts ?? 0) + 1;
    entry.nextAttemptAt = this.now() + backoffMs(entry.missingPermissionAttempts);
    this.audit(ledger, "decision", "missing_permission_retry", identity);
    return false;
  }

  /**
   * Shadow mode is a deliberate wait, not a GitHub failure: the queue entry
   * stays (source-identified) on capped backoff, never counts toward
   * `maxAttempts`, and the next live sweep re-reads config and source
   * interactions instead of blindly publishing the stored shadow record.
   */
  private retryShadow(ledger: GatesLedger, entry: QueueEntry, identity: { companyId: string; issueId: string }): boolean {
    entry.shadowAttempts = (entry.shadowAttempts ?? 0) + 1;
    entry.nextAttemptAt = this.now() + backoffMs(entry.shadowAttempts);
    this.audit(ledger, "decision", "shadow_deferred", identity);
    return false;
  }

  private async applyDecision(ledger: GatesLedger, entry: QueueEntry, config: CiConfig, decision: GatesDecision, fetch: PluginContext["http"]["fetch"], cycle: Map<string, CiAppAuth>): Promise<"done" | "retryable" | "retryable_missing_permission" | "shadow_deferred"> {
    const identity = { companyId: entry.companyId, issueId: entry.issueId, repo: decision.repo, sha: decision.sha, state: decision.state };
    if (!config.allowedRepos.includes(decision.repo)) {
      this.audit(ledger, "publish", "repo_refused", identity);
      this.ctx.logger.warn("gates: repo refused", { repo: decision.repo });
      return "done";
    }
    const key = `${decision.repo}:${decision.sha}`;
    const record = ledger.published[key];
    // Persisted watermark: a decision older than the last applied one for
    // this SHA can never republish, on any replay or list order.
    if (record?.watermarkDecidedAtMs !== undefined) {
      const older = decision.decidedAtMs < record.watermarkDecidedAtMs
        || (decision.decidedAtMs === record.watermarkDecidedAtMs
          && record.watermarkInteractionId !== undefined
          && decision.interactionId !== undefined
          && decision.interactionId < record.watermarkInteractionId);
      const alreadyApplied = decision.decidedAtMs === record.watermarkDecidedAtMs
        && decision.interactionId === record.watermarkInteractionId;
      if (older) {
        this.audit(ledger, "publish", "stale_decision", identity);
        return "done";
      }
      if (alreadyApplied && !record.shadowed && record.count > 0 && record.state === decision.state) {
        this.audit(ledger, "publish", "deduped", identity);
        return "done";
      }
    }
    if (record && !record.shadowed && record.count > 0 && record.state === decision.state) {
      // Same-state dedupe still advances the authoritative watermark when
      // this decision is strictly newer, without a POST or any change to
      // the published count/timestamp — so an older opposite-state decision
      // delivered later cannot slip past the stale guard.
      const strictlyNewer = !((record.watermarkDecidedAtMs !== undefined
        && decision.decidedAtMs < record.watermarkDecidedAtMs)
        || (record.watermarkDecidedAtMs !== undefined
          && decision.decidedAtMs === record.watermarkDecidedAtMs
          && record.watermarkInteractionId !== undefined
          && decision.interactionId !== undefined
          && decision.interactionId <= record.watermarkInteractionId));
      if (strictlyNewer) {
        record.watermarkDecidedAtMs = decision.decidedAtMs;
        if (decision.interactionId !== undefined) record.watermarkInteractionId = decision.interactionId;
        else delete record.watermarkInteractionId;
      }
      this.audit(ledger, "publish", "deduped", identity);
      return "done";
    }
    if (record && record.count >= GATES_LIMITS.statusCap) {
      this.audit(ledger, "publish", "cap_reached", identity);
      this.ctx.logger.warn("gates: status cap reached for SHA", { repo: decision.repo, sha: decision.sha });
      return "done";
    }
    const watermark = {
      watermarkDecidedAtMs: decision.decidedAtMs,
      ...(decision.interactionId !== undefined ? { watermarkInteractionId: decision.interactionId } : {}),
    };
    if (config.gatesStatusShadow) {
      // Record the authoritative shadow decision and defer the queue entry
      // (source-identified) so flipping shadow off publishes on the next
      // sweep from re-read source interactions, not from this record.
      ledger.published[key] = {
        repo: decision.repo, sha: decision.sha, state: decision.state,
        count: record?.count ?? 0, lastPublishedAt: record?.lastPublishedAt ?? 0,
        ...(record?.lastMissingPermissionAt !== undefined ? { lastMissingPermissionAt: record.lastMissingPermissionAt } : {}),
        shadowed: true, lastShadowAt: this.now(), ...watermark,
      };
      this.audit(ledger, "publish", "shadow", identity);
      this.ctx.logger.info("gates: shadow status", { context: GATES_CONTEXT, repo: decision.repo, prNumber: decision.prNumber, headSha: decision.sha, state: decision.state });
      return "shadow_deferred";
    }
    if (record?.lastMissingPermissionAt && this.now() - record.lastMissingPermissionAt < GATES_LIMITS.permissionCooldownMs) {
      this.audit(ledger, "publish", "missing_permission_cooldown", identity);
      return "retryable_missing_permission";
    }
    // Persist intent before any outbound write, mirroring the wake path:
    // a restart after the POST is deduped by the published record, never replayed.
    this.audit(ledger, "publish", "intent", identity);
    await this.save(ledger);
    try {
      const github = await this.client(entry.companyId, config, decision.repo, fetch, cycle);
      await github.createCommitStatus(decision.repo, decision.sha, decision.state, gatesDescription(decision));
    } catch (error) {
      if (isMissingPermission(error)) {
        const missing: Published = record ?? { repo: decision.repo, sha: decision.sha, state: null, count: 0, lastPublishedAt: 0 };
        missing.lastMissingPermissionAt = this.now();
        ledger.published[key] = missing;
        this.audit(ledger, "publish", "missing_permission", identity);
        this.ctx.logger.warn("gates: missing_permission", { repo: decision.repo, headSha: decision.sha, state: decision.state });
        await this.save(ledger);
        return "retryable_missing_permission";
      }
      this.audit(ledger, "publish", "publish_failed", identity);
      return "retryable";
    }
    ledger.published[key] = {
      repo: decision.repo, sha: decision.sha, state: decision.state,
      count: (record?.count ?? 0) + 1, lastPublishedAt: this.now(), ...watermark,
    };
    this.audit(ledger, "publish", "published", identity);
    this.ctx.logger.info("gates: status published", { context: GATES_CONTEXT, repo: decision.repo, headSha: decision.sha, state: decision.state });
    return "done";
  }
}
