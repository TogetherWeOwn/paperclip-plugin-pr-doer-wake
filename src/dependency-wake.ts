import { createHash } from "node:crypto";
import type { Issue, PluginContext } from "@paperclipai/plugin-sdk";
import { UUID } from "./ci-config.js";
import { retryableBeforeQueue } from "./native-wake.js";

/**
 * Interim dependency wake. Core wakes a dependent when its last blocker goes
 * done, but when that wake is gated by the blocker's workspace finalize, the
 * finalize/periodic backstop re-wakes only `blocked` dependents, so an
 * `in_review` or `in_progress` dependent is never woken. This job wakes such a
 * dependent's assignee once per (dependent, blocker). Retire it once core
 * covers non-blocked dependents.
 */
export const DEPENDENCY_WAKE_LIMITS = {
  graceMs: 600_000, lookbackMs: 7 * 86_400_000, retentionMs: 30 * 86_400_000,
  maxPerStatus: 1_000, hostReads: 800, wakesPerTick: 10, tickMs: 120_000, audits: 500,
  // Storage bound. A receipt whose blocker is still inside the lookback is the
  // dedupe record and is never evicted; when such receipts fill the cap the job
  // fails closed (no new effect, tick incomplete) instead of risking a repeat.
  // This is below the worst-case live rate over the lookback (10 wakes per
  // 5-minute tick, about 20,000), deliberately: one company finishing 5,000
  // (dependent, blocker) pairs in 7 days is far beyond a normal workload, and the
  // excess is deferred and reported rather than lost or repeated.
  receipts: 5_000,
} as const;
const L = DEPENDENCY_WAKE_LIMITS;
const STATUSES = ["in_review", "in_progress"] as const;
const LIVE = new Set(["queued", "running"]);
const STOPS = ["tick_budget", "wake_budget", "receipt_capacity", "wake_intent_write_failed", "configuration_changed"];

export interface DependencyWakeConfig { enabled: boolean; shadow: boolean; companyId: string | null }
export function parseDependencyWakeConfig(raw: Record<string, unknown>): DependencyWakeConfig {
  const id = raw.dependencyWakeCompanyId;
  return { enabled: raw.dependencyWakeEnabled === true, shadow: raw.dependencyWakeShadow !== false, companyId: typeof id === "string" && UUID.test(id) ? id.toLowerCase() : null };
}
export function validateDependencyWakeConfig(raw: Record<string, unknown>): string[] {
  return raw.dependencyWakeEnabled === true && !parseDependencyWakeConfig(raw).companyId ? ["dependencyWakeCompanyId must be a UUID when dependencyWakeEnabled is true"] : [];
}

type Outcome = "would_wake" | "intent" | "woken" | "not_queued" | "unconfirmed";
interface Receipt { at: number; outcome: Outcome; blockerDoneAt: number; runId?: string | null }
export interface DependencyWakeLedger {
  version: 1;
  /** Keyed `${dependentId}:${blockerId}`; at most one effect per key within retention. */
  receipts: Record<string, Receipt>;
  audits: Array<{ at: number; outcome: string; issueId?: string }>;
  /** Id of the first candidate (in id order) the next tick examines; absent = start of the list. */
  cursor?: string;
  lastTick?: { at: number; complete: boolean; examined: number; eligible: number; wakes: number };
}
interface Tick {
  companyId: string; shadow: boolean; key: { scopeKind: "company"; scopeId: string; namespace: string; stateKey: string };
  ledger: DependencyWakeLedger; report: NonNullable<DependencyWakeLedger["lastTick"]>;
  read: <T>(fn: () => Promise<T>) => Promise<T>; audit: (outcome: string, issueId?: string) => void;
  blockers: Map<string, Promise<Issue | null>>;
}
type Blocker = { id: string; identifier: string | null; status: string };
const time = (value: unknown): number => (value == null ? NaN : new Date(value as string).getTime());
/** A receipt still dedupes while its blocker is inside the lookback; after that the blocker is never fresh again. */
const relevant = (r: Receipt, now: number) => r.blockerDoneAt >= now - L.lookbackMs;

export class DependencyWakeRuntime {
  private companyId: string | null = null;
  private inFlight: Promise<void> | null = null;
  constructor(private readonly ctx: PluginContext, private readonly now: () => number = Date.now) {}

  /** Scheduled jobs carry no company scope; the host-delivered config capture supplies it (as for custody). */
  setCompanyId(companyId: string | null): void {
    this.companyId = companyId && UUID.test(companyId) ? companyId.toLowerCase() : null;
  }

  /** Overlapping ticks coalesce onto the one in flight. */
  poll(): Promise<void> {
    if (!this.inFlight) this.inFlight = this.tick().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async tick(): Promise<void> {
    const companyId = this.companyId;
    if (!companyId) return;
    const config = parseDependencyWakeConfig(await this.ctx.config.get(companyId));
    if (!config.enabled || config.companyId !== companyId) return;
    // Shadow and live keep separate ledgers so shadow evidence never suppresses a live wake.
    const key = { scopeKind: "company" as const, scopeId: companyId, namespace: "dependency-wake-v1", stateKey: config.shadow ? "shadow" : "live" };
    const stored = await this.ctx.state.get(key) as DependencyWakeLedger | null;
    if (stored && (stored.version !== 1 || !stored.receipts || !Array.isArray(stored.audits))) throw new Error("invalid_dependency_wake_ledger");
    const ledger: DependencyWakeLedger = stored ?? { version: 1, receipts: {}, audits: [] };
    const started = this.now();
    let reads = 0;
    const tick: Tick = {
      companyId, shadow: config.shadow, key, ledger, blockers: new Map(),
      report: { at: started, complete: false, examined: 0, eligible: 0, wakes: 0 },
      read: (fn) => {
        if (++reads > L.hostReads || this.now() - started >= L.tickMs) throw new Error("tick_budget");
        return fn();
      },
      audit: (outcome, issueId) => {
        ledger.audits.push({ at: this.now(), outcome, ...(issueId ? { issueId } : {}) });
        ledger.audits = ledger.audits.slice(-L.audits);
      },
    };
    try {
      let capped = false;
      const candidates: Array<{ issue: Issue; status: (typeof STATUSES)[number] }> = [];
      for (const status of STATUSES) {
        // One bounded page per status: the installed host applies `offset` twice
        // (SQL, then the plugin window), so any offset > 0 reads an empty page.
        const page = await tick.read(() => this.ctx.issues.list({ companyId, status, limit: L.maxPerStatus }));
        if (page.length >= L.maxPerStatus) { capped = true; tick.audit("candidate_cap"); }
        for (const issue of page) candidates.push({ issue, status });
      }
      // Stable id order plus a persisted cursor: a tick that runs out of budget
      // resumes where it stopped, so every candidate in both statuses is reached.
      candidates.sort((a, b) => (a.issue.id < b.issue.id ? -1 : a.issue.id > b.issue.id ? 1 : 0));
      const cursor = ledger.cursor;
      const start = Math.max(0, cursor ? candidates.findIndex((c) => c.issue.id >= cursor) : 0);
      for (let i = start; i < candidates.length; i += 1) {
        const { issue, status } = candidates[i]!;
        try { await this.consider(tick, issue, status); } catch (error) {
          if (error instanceof Error && STOPS.includes(error.message)) {
            // Retry this candidate next tick, unless it alone exhausted a fresh read budget.
            const next = error.message === "tick_budget" && i === start ? candidates[i + 1]?.issue.id : issue.id;
            if (next) ledger.cursor = next; else delete ledger.cursor;
            throw error;
          }
          tick.audit("candidate_error", issue.id);
        }
      }
      delete ledger.cursor;
      tick.report.complete = !capped && start === 0;
    } catch (error) {
      tick.audit(error instanceof Error && ["tick_budget", "wake_budget", "receipt_capacity", "configuration_changed"].includes(error.message) ? error.message : "tick_error");
    } finally {
      // Still-relevant receipts are kept whatever their number; only stale ones are evicted, oldest first.
      const now = this.now();
      const kept = Object.entries(ledger.receipts).filter(([, r]) => relevant(r, now));
      const stale = Object.entries(ledger.receipts).filter(([, r]) => !relevant(r, now) && r.at >= now - L.retentionMs).sort((a, b) => b[1].at - a[1].at);
      ledger.receipts = Object.fromEntries([...kept, ...stale.slice(0, Math.max(0, L.receipts - kept.length))]);
      ledger.lastTick = tick.report;
      await this.ctx.state.set(key, ledger);
    }
  }

  private async liveRun(tick: Tick, issueId: string) {
    const summary = await tick.read(() => this.ctx.issues.summaries.getOrchestration({ issueId, companyId: tick.companyId }));
    const runs = summary.runs.filter((run) => run.issueId === issueId);
    return { runs, live: runs.some((run) => LIVE.has(run.status)), budgetBlocked: summary.invocationBlocks.some((b) => b.issueId === issueId) };
  }

  private async consider(tick: Tick, issue: Issue, status: (typeof STATUSES)[number]): Promise<void> {
    const { companyId, ledger, report } = tick;
    const extra = issue as unknown as { activeRun?: unknown; conversationAgentId?: unknown };
    if (issue.status !== status || !issue.assigneeAgentId || extra.activeRun || extra.conversationAgentId) return;
    report.examined += 1;
    const blockers = (await tick.read(() => this.ctx.issues.relations.get(issue.id, companyId))).blockedBy as Blocker[];
    // Any open (or cancelled) blocker: core treats it as unresolved, and so do we.
    if (!blockers.length || blockers.some((b) => b.status !== "done")) return;
    const seen = (b: Blocker) => Boolean(ledger.receipts[`${issue.id}:${b.id}`]);
    if (blockers.every(seen)) return;
    const doneAt = new Map<string, number>();
    for (const b of blockers) {
      if (!tick.blockers.has(b.id)) tick.blockers.set(b.id, tick.read(() => this.ctx.issues.get(b.id, companyId)));
      const full = await tick.blockers.get(b.id)!;
      const at = time(full?.completedAt);
      if (full?.status === "done" && Number.isFinite(at)) doneAt.set(b.id, at);
    }
    // Unknown completion time on any blocker: no evidence, no wake. Every blocker must be settled for the grace period.
    const now = this.now();
    if (doneAt.size !== blockers.length || now - Math.max(...doneAt.values()) < L.graceMs) return;
    const fresh = blockers.filter((b) => !seen(b) && doneAt.get(b.id)! >= now - L.lookbackMs);
    if (!fresh.length) return;
    const dependent = await this.liveRun(tick, issue.id);
    if (dependent.live || dependent.budgetBlocked) return;
    // Watermark on start only: a run that started before a blocker finished was built without
    // that completion, even if it ended after it; a run that never started saw nothing at all.
    const lastRun = Math.max(-Infinity, ...dependent.runs.map((run) => time(run.startedAt)).filter(Number.isFinite));
    // Only blockers that finished after the dependent's last run started; an earlier one was seen by that run.
    const triggers = fresh.filter((b) => doneAt.get(b.id)! > lastRun);
    if (!triggers.length) return;
    // A done blocker with a live run may still be finalizing its workspace: wait for it.
    for (const b of triggers) if ((await this.liveRun(tick, b.id)).live) return;
    report.eligible += 1;
    // Fail closed rather than evict a dedupe record: resume at this candidate once old receipts age out.
    if (Object.values(ledger.receipts).filter((r) => relevant(r, now)).length + triggers.length > L.receipts) throw new Error("receipt_capacity");
    const record = (outcome: Outcome, runId?: string | null) => {
      for (const b of triggers) ledger.receipts[`${issue.id}:${b.id}`] = { at: this.now(), outcome, blockerDoneAt: doneAt.get(b.id)!, ...(runId !== undefined ? { runId } : {}) };
    };
    const forget = () => { for (const b of triggers) delete ledger.receipts[`${issue.id}:${b.id}`]; };
    if (tick.shadow) {
      record("would_wake");
      tick.audit("would_wake", issue.id);
      this.ctx.logger.info("dependency-wake: would wake", { issueId: issue.id, status, blockerIds: triggers.map((b) => b.id) });
      return;
    }
    // Out of wakes: stop here and resume at this candidate next tick (the tick reports incomplete).
    if (report.wakes >= L.wakesPerTick) throw new Error("wake_budget");
    // Re-read config right before the effect: a rollback (disable or shadow) made mid-tick wins.
    const current = parseDependencyWakeConfig(await tick.read(() => this.ctx.config.get(companyId)));
    if (!current.enabled || current.shadow || current.companyId !== companyId) throw new Error("configuration_changed");
    // Persist intent BEFORE the host call: a lost reply or restart never repeats the effect.
    record("intent");
    try { await this.ctx.state.set(tick.key, ledger); } catch { forget(); throw new Error("wake_intent_write_failed"); }
    report.wakes += 1;
    const ids = triggers.map((b) => b.id).sort();
    const reason = `dependency_blockers_done: ${triggers.map((b) => b.identifier ?? b.id).join(", ")} done; ${status} dependent not run since`;
    try {
      const result = await this.ctx.issues.requestWakeup(issue.id, companyId, {
        reason, contextSource: "plugin.dependency-wake",
        idempotencyKey: `dependency-wake:${issue.id}:${createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 32)}`,
      });
      record(result.queued ? "woken" : "not_queued", result.runId);
      tick.audit(result.queued ? "woken" : "not_queued", issue.id);
    } catch (error) {
      if (retryableBeforeQueue(error)) { forget(); tick.audit("host_deferred", issue.id); } else {
        record("unconfirmed");
        tick.audit("unconfirmed", issue.id);
        this.ctx.logger.warn("dependency-wake: wake unconfirmed", { issueId: issue.id });
      }
    }
    await this.ctx.state.set(tick.key, ledger);
  }
}
