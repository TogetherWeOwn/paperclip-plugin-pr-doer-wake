import { createHash } from "node:crypto";
import type { Issue, PluginContext } from "@paperclipai/plugin-sdk";
import { UUID } from "./ci-config.js";
import { retryableBeforeQueue } from "./native-wake.js";

/**
 * Interim dependency wake. Core wakes a dependent when its last blocker goes
 * done, but when that wake is gated by the blocker's workspace finalize, the
 * finalize/periodic backstop re-wakes only `blocked` dependents, so an
 * `in_review` or `in_progress` dependent is never woken. This job wakes such a
 * dependent's assignee once per (dependent, blocker, blocker completion epoch):
 * a reopened blocker loses its completedAt and gets a new one when done again,
 * which is a distinct event. Retire it once core covers non-blocked dependents.
 */
export const DEPENDENCY_WAKE_LIMITS = {
  graceMs: 600_000, lookbackMs: 7 * 86_400_000, retentionMs: 30 * 86_400_000,
  // hostReads 805 is the 800 cap plus the five reads a supported full-fan-in
  // candidate needs after the all-blocker liveness barrier was added (a
  // candidate's blocker summaries are now read even when every blocker is
  // already receipted or outside the lookback).
  maxPerStatus: 1_000, hostReads: 805, wakesPerTick: 10, tickMs: 120_000, audits: 500,
  // Supported fan-in: a candidate with more than 400 blockers cannot be
  // verified inside one tick's read budget (relation + per-blocker issue reads
  // + dependent and per-blocker summaries + the pre-effect config re-read), so
  // it is audited, deferred and reported incomplete rather than half-examined.
  maxBlockers: 400,
  // Storage bound. A receipt whose blocker is still inside the lookback is the
  // dedupe record and is never evicted; when such receipts fill the cap the job
  // fails closed (no new effect, tick incomplete) instead of risking a repeat.
  // This is below the worst-case live rate over the lookback (10 wakes per
  // 5-minute tick, about 20,000), deliberately: one company finishing 5,000
  // (dependent, blocker) pairs in 7 days is far beyond a normal workload, and the
  // excess is deferred and reported rather than lost or repeated.
  receipts: 5_000,
  // The host's run summary returns only the newest 100 runs (by createdAt) of ANY agent on the issue
  // (plugin-host-services getIssueRunSummaries); a full window may have dropped the assignee's runs.
  hostRunWindow: 100,
} as const;
const L = DEPENDENCY_WAKE_LIMITS;
const STATUSES = ["in_review", "in_progress"] as const;
const LIVE = new Set(["queued", "running"]);
const STOPS = ["tick_budget", "wake_budget", "receipt_capacity", "wake_intent_write_failed", "configuration_changed"];

export interface DependencyWakeConfig { enabled: boolean; shadow: boolean; companyId: string | null }
export function parseDependencyWakeConfig(raw: Record<string, unknown>): DependencyWakeConfig {
  const id = raw.dependencyWakeCompanyId;
  // dryRun (default true) is the global kill switch: effective shadow is dependencyWakeShadow || dryRun.
  const shadow = raw.dependencyWakeShadow !== false || raw.dryRun !== false;
  return { enabled: raw.dependencyWakeEnabled === true, shadow, companyId: typeof id === "string" && UUID.test(id) ? id.toLowerCase() : null };
}
export function validateDependencyWakeConfig(raw: Record<string, unknown>): string[] {
  return raw.dependencyWakeEnabled === true && !parseDependencyWakeConfig(raw).companyId ? ["dependencyWakeCompanyId must be a UUID when dependencyWakeEnabled is true"] : [];
}

type Outcome = "would_wake" | "intent" | "woken" | "unconfirmed";
interface Receipt { at: number; outcome: Outcome; blockerDoneAt: number; runId?: string | null }
export interface DependencyWakeLedger {
  version: 1;
  /**
   * Keyed `${dependentId}:${blockerId}:${blockerDoneAt}` (completedAt epoch ms): at most one effect per
   * completion epoch. A key is never evicted while its epoch is inside the lookback, and an epoch outside
   * the lookback is never eligible, so eviction cannot cause a repeat.
   */
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
  blockers: Map<string, Promise<Issue | null>>; deferred: boolean;
}
type Blocker = { id: string; identifier: string | null; status: string };
const time = (value: unknown): number => (value == null ? NaN : new Date(value as string).getTime());
/** A receipt still dedupes while its blocker is inside the lookback; after that the blocker is never fresh again. */
const relevant = (r: Receipt, now: number) => r.blockerDoneAt >= now - L.lookbackMs;
const receiptKey = (dependentId: string, blockerId: string, doneAt: number) => `${dependentId}:${blockerId}:${doneAt}`;

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
    // An old not_queued receipt suppressed retry even though no run was queued: a confirmed
    // non-queued result is now released instead, so any recorded ones must not keep deduping.
    for (const [key, receipt] of Object.entries(ledger.receipts)) if ((receipt as { outcome: string }).outcome === "not_queued") delete ledger.receipts[key];
    const started = this.now();
    let reads = 0;
    const tick: Tick = {
      companyId, shadow: config.shadow, key, ledger, blockers: new Map(), deferred: false,
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
      // A failed status page is isolated to that status: the other still sweeps, and the
      // tick reports incomplete so the failure is not mistaken for a quiet pass.
      let listFailed = false;
      const candidates: Array<{ issue: Issue; status: (typeof STATUSES)[number] }> = [];
      for (const status of STATUSES) {
        try {
          // One bounded page per status: the installed host applies `offset` twice
          // (SQL, then the plugin window), so any offset > 0 reads an empty page.
          const page = await tick.read(() => this.ctx.issues.list({ companyId, status, limit: L.maxPerStatus }));
          if (page.length >= L.maxPerStatus) { capped = true; tick.audit("candidate_cap"); }
          for (const issue of page) candidates.push({ issue, status });
        } catch (error) {
          if (error instanceof Error && error.message === "tick_budget") throw error;
          listFailed = true;
          tick.audit("status_list_error");
        }
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
      tick.report.complete = !capped && !listFailed && !tick.deferred && start === 0;
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

  /**
   * The summary lists recent runs of ANY agent on the issue. `live` counts every agent (a live
   * reviewer or other participant run on the dependent defers the wake to a later tick rather than
   * stacking a second run on the card); `runs` keeps only `agentId`'s, for the seen-it watermark.
   */
  private async liveRun(tick: Tick, issueId: string, agentId?: string) {
    const summary = await tick.read(() => this.ctx.issues.summaries.getOrchestration({ issueId, companyId: tick.companyId }));
    const all = summary.runs.filter((run) => run.issueId === issueId);
    const runs = agentId ? all.filter((run) => run.agentId === agentId) : all;
    const truncated = summary.runs.length >= L.hostRunWindow;
    return { runs, truncated, live: all.some((run) => LIVE.has(run.status)), budgetBlocked: summary.invocationBlocks.some((b) => b.issueId === issueId) };
  }

  private async consider(tick: Tick, issue: Issue, status: (typeof STATUSES)[number]): Promise<void> {
    const { companyId, ledger, report } = tick;
    const extra = issue as unknown as { activeRun?: unknown; conversationAgentId?: unknown };
    if (issue.status !== status || !issue.assigneeAgentId || extra.activeRun || extra.conversationAgentId) return;
    report.examined += 1;
    const blockers = (await tick.read(() => this.ctx.issues.relations.get(issue.id, companyId))).blockedBy as Blocker[];
    // Any open (or cancelled) blocker: core treats it as unresolved, and so do we.
    if (!blockers.length || blockers.some((b) => b.status !== "done")) return;
    // Fan-in beyond the supported bound cannot be verified within one tick's
    // read budget: audit and defer (tick reported incomplete) instead of
    // examining part of the set and quietly passing.
    if (blockers.length > L.maxBlockers) { tick.audit("blocker_fan_in", issue.id); tick.deferred = true; return; }
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
    const key = (b: Blocker) => receiptKey(issue.id, b.id, doneAt.get(b.id)!);
    const seen = (b: Blocker) => Boolean(ledger.receipts[key(b)]);
    const fresh = blockers.filter((b) => !seen(b) && doneAt.get(b.id)! >= now - L.lookbackMs);
    if (!fresh.length) return;
    const dependent = await this.liveRun(tick, issue.id, issue.assigneeAgentId);
    if (dependent.live || dependent.budgetBlocked) return;
    // Liveness barrier over EVERY blocker, regardless of receipt, lookback or
    // settlement eligibility: a live run or an unbounded window on any blocker —
    // including one whose epoch already fired or is too old to trigger — means a
    // finalizing run may still be hiding, so the dependent defers as a whole
    // (no receipt, no effect). A failed summary read propagates and retries the
    // candidate next tick; each summary is read once here and reused for
    // settlement below. The 400-blocker fan-in bound and the 805-read tick cap
    // are sized so a supported candidate always fits a fresh budget.
    const views = new Map<string, Awaited<ReturnType<DependencyWakeRuntime["liveRun"]>>>();
    for (const b of blockers) {
      const view = await this.liveRun(tick, b.id);
      if (view.live || view.budgetBlocked) return;
      if (view.truncated) { tick.audit("blocker_window_truncated", issue.id); return; }
      views.set(b.id, view);
    }
    // Watermark on the assignee's runs, on start only: another agent's run (a reviewer) is not the
    // assignee seeing the blocker; a run that never started saw nothing at all.
    const lastRun = Math.max(-Infinity, ...dependent.runs.map((run) => time(run.startedAt)).filter(Number.isFinite));
    // A blocker is settled only when the run(s) spanning its completion have finished: an issue
    // can be marked done while a run still finalizes the workspace, so a dependent run started
    // in that done-to-finalize window was built without the completion and must not consume the
    // trigger. Settlement for epoch B is the conservative temporal envelope max(B, finishes of
    // runs with startedAt <= B <= finishedAt): runs that started after B can never have produced
    // this completion, so they must not advance the watermark (the separate live-run check above
    // still defers a currently-live one). Malformed or inconsistent run timestamps, or no
    // qualifying interval at all, mean the bound cannot be established for that blocker: it is
    // audited, left unreceipted and retried next tick, but it does not suppress another blocker's
    // established settlement — an unknown older completion never invalidates separate evidence
    // for a newer one. A live blocker run or a full run window on ANY blocker already
    // deferred the whole dependent in the barrier above (workspace-finalize policy): a
    // full window cannot rule out a hidden live run, so it is a dependent-wide
    // deferral there, not merely an unknown bound here.
    const settledAt = new Map<string, number>();
    for (const b of fresh) {
      const blocker = views.get(b.id)!;
      const done = doneAt.get(b.id)!;
      let malformed = false;
      let span = -Infinity;
      for (const run of blocker.runs) {
        const started = time(run.startedAt);
        if (run.startedAt == null) continue; // a never-started terminal run is not completion evidence
        if (!Number.isFinite(started)) { malformed = true; break; }
        const finished = time(run.finishedAt);
        if (!Number.isFinite(finished) || finished < started) { malformed = true; break; }
        if (started <= done && finished >= done) span = Math.max(span, finished);
      }
      if (malformed || !Number.isFinite(span)) { tick.audit("blocker_settlement_unknown", issue.id); continue; }
      settledAt.set(b.id, Math.max(done, span));
    }
    // Only blockers that settled after the dependent's last run started; an earlier one was seen by that run.
    const triggers = fresh.filter((b) => settledAt.has(b.id) && settledAt.get(b.id)! > lastRun);
    if (!triggers.length) return;
    // A full window may have dropped an assignee run that started after a trigger: unknown, so no wake.
    if (dependent.truncated) { tick.audit("run_window_truncated", issue.id); return; }
    report.eligible += 1;
    // Fail closed rather than evict a dedupe record: resume at this candidate once old receipts age out.
    if (Object.values(ledger.receipts).filter((r) => relevant(r, now)).length + triggers.length > L.receipts) throw new Error("receipt_capacity");
    const record = (outcome: Outcome, runId?: string | null) => {
      for (const b of triggers) ledger.receipts[key(b)] = { at: this.now(), outcome, blockerDoneAt: doneAt.get(b.id)!, ...(runId !== undefined ? { runId } : {}) };
    };
    const forget = () => { for (const b of triggers) delete ledger.receipts[key(b)]; };
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
    // Epoch-qualified, so a genuine re-completion is not collapsed into the earlier wake by the host.
    const ids = triggers.map(key).sort();
    const reason = `dependency_blockers_done: ${triggers.map((b) => b.identifier ?? b.id).join(", ")} done; ${status} dependent not run since`;
    try {
      const result = await this.ctx.issues.requestWakeup(issue.id, companyId, {
        reason, contextSource: "plugin.dependency-wake",
        idempotencyKey: `dependency-wake:${issue.id}:${createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 32)}`,
      });
      // A confirmed non-queued result provably ran no effect: release the intent (like
      // custody's pending receipt) so a later tick retries with the same epoch key. Only a
      // queued wake or an ambiguous failure stays recorded.
      if (result.queued) { record("woken", result.runId); tick.audit("woken", issue.id); }
      else { forget(); tick.audit("host_deferred", issue.id); }
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
