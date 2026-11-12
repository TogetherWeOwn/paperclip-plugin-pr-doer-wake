import type { PluginContext } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { DEPENDENCY_WAKE_LIMITS, DependencyWakeRuntime, validateDependencyWakeConfig, type DependencyWakeLedger } from "../src/dependency-wake.js";
import { validateCiConfig } from "../src/ci-config.js";
import manifest from "../src/manifest.js";
import { validateInstanceConfig } from "./fixtures/host-config-validator.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const DEP = "44444444-4444-4444-8444-444444444444";
const BLK = "55555555-5555-4555-8555-555555555555";
const BLK2 = "66666666-6666-4666-8666-666666666666";
const DEP2 = "77777777-7777-4777-8777-777777777777";
const REVIEWER = "88888888-8888-4888-8888-888888888888";
/** Receipt key: one dedupe record per (dependent, blocker, blocker completion epoch). */
const rk = (dep: string, blk: string, doneAt: number) => `${dep}:${blk}:${doneAt}`;
const DONE = 1_800_000_000_000 - 30 * 60_000;
// Ids that sort before DEP, so a bounded traversal reaches them first.
const filler = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const wokenIds = (h: { ctx: { issues: { requestWakeup: { mock: { calls: unknown[] } } } } }) => (h.ctx.issues.requestWakeup.mock.calls as Array<[string]>).map(([id]) => id);
const START = 1_800_000_000_000;
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
// dryRun is the global kill switch (default true): live wakes need it explicitly false.
const live = { dryRun: false, dependencyWakeEnabled: true, dependencyWakeShadow: false, dependencyWakeCompanyId: COMPANY };

function harness() {
  const state = new Map<string, unknown>();
  let config: Record<string, unknown> = { ...live };
  const issues: Record<string, Record<string, unknown>> = {
    [DEP]: { id: DEP, companyId: COMPANY, status: "in_review", assigneeAgentId: AGENT, activeRun: null },
    [BLK]: { id: BLK, companyId: COMPANY, status: "done", completedAt: iso(START - 30 * MIN) },
  };
  const relations: Record<string, Array<Record<string, unknown>>> = { [DEP]: [{ id: BLK, identifier: "TWO-1", status: "done" }] };
  const runs: Record<string, Array<Record<string, unknown>>> = {
    [DEP]: [{ id: "r1", issueId: DEP, agentId: AGENT, status: "succeeded", createdAt: iso(START - 90 * MIN), startedAt: iso(START - 90 * MIN), finishedAt: iso(START - 60 * MIN) }],
    // The run that produced the completion spans it: started before completedAt, finished at it.
    [BLK]: [{ id: "b1", issueId: BLK, agentId: REVIEWER, status: "succeeded", createdAt: iso(START - 45 * MIN), startedAt: iso(START - 45 * MIN), finishedAt: iso(START - 30 * MIN) }],
  };
  const budgetBlocks: Array<Record<string, unknown>> = [];
  const ctx = {
    config: { get: vi.fn(async () => config) },
    state: { get: async (key: unknown) => structuredClone(state.get(JSON.stringify(key)) ?? null), set: async (key: unknown, value: unknown) => { state.set(JSON.stringify(key), structuredClone(value)); } },
    issues: {
      list: vi.fn(async ({ status, limit }: { status: string; limit?: number }) => Object.values(issues).filter((i) => i.status === status).slice(0, limit)),
      get: vi.fn(async (id: string) => issues[id] ?? null),
      relations: { get: vi.fn(async (id: string) => ({ blockedBy: relations[id] ?? [], blocks: [] })) },
      // Like the host (getIssueRunSummaries): the newest 100 runs by createdAt, across all agents.
      summaries: { getOrchestration: vi.fn(async ({ issueId }: { issueId: string }) => ({ runs: [...(runs[issueId] ?? [])].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 100), invocationBlocks: budgetBlocks })) },
      requestWakeup: vi.fn(async (): Promise<{ queued: boolean; runId: string | null }> => ({ queued: true, runId: "run-new" })),
    },
    logger: { info: vi.fn(), warn: vi.fn() },
  };
  const runtime = new DependencyWakeRuntime(ctx as unknown as PluginContext, () => START);
  runtime.setCompanyId(COMPANY);
  const stateKey = (mode: string) => JSON.stringify({ scopeKind: "company", scopeId: COMPANY, namespace: "dependency-wake-v1", stateKey: mode });
  const ledger = (mode = "live") => state.get(stateKey(mode)) as DependencyWakeLedger | undefined;
  const seed = (next: DependencyWakeLedger, mode = "live") => { state.set(stateKey(mode), structuredClone(next)); };
  return { ctx, runtime, issues, relations, runs, budgetBlocks, ledger, seed, setConfig: (next: Record<string, unknown>) => { config = next; } };
}

describe("dependency wake", () => {
  it("wakes an in_review dependent once per (dependent, blocker completion), persisting intent before the host call", async () => {
    const h = harness();
    h.ctx.issues.requestWakeup.mockImplementationOnce(async () => {
      expect(h.ledger()?.receipts[rk(DEP, BLK, DONE)]?.outcome).toBe("intent");
      return { queued: true, runId: "run-new" };
    });
    await h.runtime.poll();
    expect(h.ledger()?.lastTick).toMatchObject({ complete: true, examined: 1, eligible: 1, wakes: 1 });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
    const [issueId, companyId, options] = h.ctx.issues.requestWakeup.mock.calls[0] as unknown as [string, string, Record<string, string>];
    expect([issueId, companyId, options.contextSource]).toEqual([DEP, COMPANY, "plugin.dependency-wake"]);
    expect(options.reason).toContain("TWO-1 done; in_review dependent not run since");
    expect(options.idempotencyKey).toMatch(new RegExp(`^dependency-wake:${DEP}:[0-9a-f]{32}$`));
    expect(h.ledger()?.receipts[rk(DEP, BLK, DONE)]).toMatchObject({ outcome: "woken", runId: "run-new", blockerDoneAt: START - 30 * MIN });
    expect(h.ledger()?.lastTick).toMatchObject({ complete: true, examined: 1, eligible: 0, wakes: 0 });
  });

  it("also covers in_progress dependents and wakes again only for a newly finished blocker", async () => {
    const h = harness();
    h.issues[DEP]!.status = "in_progress";
    await h.runtime.poll();
    h.issues[BLK2] = { id: BLK2, companyId: COMPANY, status: "done", completedAt: iso(START - 15 * MIN) };
    h.runs[BLK2] = [{ id: "b1", issueId: BLK2, agentId: REVIEWER, status: "succeeded", createdAt: iso(START - 20 * MIN), startedAt: iso(START - 20 * MIN), finishedAt: iso(START - 15 * MIN) }];
    h.relations[DEP]!.push({ id: BLK2, identifier: "TWO-2", status: "done" });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(2);
    expect((h.ctx.issues.requestWakeup.mock.calls[1] as unknown as [string, string, { reason: string }])[2].reason).toContain("TWO-2 done; in_progress");
  });

  it("shadow (the default) logs once without firing and never suppresses the later live wake", async () => {
    const h = harness();
    h.setConfig({ dependencyWakeEnabled: true, dependencyWakeCompanyId: COMPANY });
    await h.runtime.poll();
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
    expect(h.ctx.logger.info).toHaveBeenCalledTimes(1);
    expect(h.ledger("shadow")?.receipts[rk(DEP, BLK, DONE)]?.outcome).toBe("would_wake");
    h.setConfig({ ...live });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });

  const skips: Array<[string, (h: ReturnType<typeof harness>) => void]> = [
    ["blocker done under 10 minutes ago", (h) => { h.issues[BLK]!.completedAt = iso(START - 9 * MIN); }],
    ["another blocker still open", (h) => { h.relations[DEP]!.push({ id: BLK2, identifier: "TWO-2", status: "in_progress" }); }],
    ["a cancelled blocker", (h) => { h.relations[DEP]!.push({ id: BLK2, identifier: "TWO-2", status: "cancelled" }); }],
    ["blocker completion time unknown", (h) => { h.issues[BLK]!.completedAt = null; }],
    ["blocker done outside the lookback", (h) => { h.issues[BLK]!.completedAt = iso(START - 8 * 1_440 * MIN); h.runs[DEP] = []; }],
    ["no agent assignee", (h) => { h.issues[DEP]!.assigneeAgentId = null; }],
    ["dependent holds an active execution run", (h) => { h.issues[DEP]!.activeRun = { id: "x", status: "running" }; }],
    ["dependent has a queued run", (h) => { h.runs[DEP]!.push({ id: "r2", issueId: DEP, agentId: AGENT, status: "queued", createdAt: iso(START - MIN), startedAt: null, finishedAt: null }); }],
    ["dependent started a run after the blocker finished", (h) => { Object.assign(h.runs[DEP]![0]!, { startedAt: iso(START - 25 * MIN), finishedAt: iso(START - 20 * MIN) }); }],
    ["blocker still has a live run (finalize pending)", (h) => { h.runs[BLK] = [{ id: "b1", issueId: BLK, agentId: REVIEWER, status: "running", createdAt: iso(START - 40 * MIN), startedAt: iso(START - 40 * MIN), finishedAt: null }]; }],
    ["blocker's run window is full (an older live run may be hidden)", (h) => { h.runs[BLK] = Array.from({ length: 100 }, (_, i) => ({ id: `b${i}`, issueId: BLK, agentId: REVIEWER, status: "succeeded", createdAt: iso(START - 40 * MIN + i * 1_000), startedAt: iso(START - 40 * MIN + i * 1_000), finishedAt: iso(START - 40 * MIN + i * 1_000 + 500) })); }],
    ["another agent (e.g. a reviewer) has a live run on the dependent", (h) => { h.runs[DEP]!.push({ id: "rv", issueId: DEP, agentId: REVIEWER, status: "running", createdAt: iso(START - 2 * MIN), startedAt: iso(START - 2 * MIN), finishedAt: null }); }],
    ["budget invocation block", (h) => { h.budgetBlocks.push({ issueId: DEP, agentId: AGENT }); }],
    ["dependent not in a covered status", (h) => { h.issues[DEP]!.status = "todo"; }],
  ];
  it.each(skips)("does not wake when %s", async (_name, mutate) => {
    const h = harness();
    mutate(h);
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger()?.receipts ?? {}).toEqual({});
  });

  it("does not let a never-started run (queued before, cancelled after the blocker finished) suppress the wake", async () => {
    const h = harness();
    // Host cancels a queued run on reassignment with startedAt=null; it never saw the blocker's completion.
    h.runs[DEP]!.push({ id: "r2", issueId: DEP, agentId: AGENT, status: "cancelled", createdAt: iso(START - 40 * MIN), startedAt: null, finishedAt: iso(START - 20 * MIN) });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });

  it("wakes when the dependent's last run started before the blocker finished, even if it ended after", async () => {
    const h = harness();
    // The run was built before the blocker finished and had no completion signal from it.
    h.runs[DEP]![0]!.finishedAt = iso(START - 20 * MIN);
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });

  // Receipts for other dependents whose blockers are still inside the lookback (newer than DEP's).
  const heldReceipts = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [rk(filler(i), BLK2, START - 5 * MIN), { at: START - MIN, outcome: "woken" as const, blockerDoneAt: START - 5 * MIN }]));

  it("never evicts a still-relevant receipt at the cap, so a wake whose run never started is not repeated", async () => {
    const h = harness();
    h.seed({ version: 1, audits: [], receipts: { [rk(DEP, BLK, DONE)]: { at: START - 25 * MIN, outcome: "woken", blockerDoneAt: START - 30 * MIN, runId: "run-new" }, ...heldReceipts(DEPENDENCY_WAKE_LIMITS.receipts) } });
    // The queued wake was cancelled before it started, so it sets no run watermark.
    h.runs[DEP]!.push({ id: "run-new", issueId: DEP, agentId: AGENT, status: "cancelled", createdAt: iso(START - 25 * MIN), startedAt: null, finishedAt: iso(START - 24 * MIN) });
    for (let n = 0; n < 3; n += 1) await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger()?.receipts[rk(DEP, BLK, DONE)]?.outcome).toBe("woken");
  });

  it("fails closed when still-relevant receipts fill the cap, and evicts stale ones first", async () => {
    const h = harness();
    h.seed({ version: 1, audits: [], receipts: heldReceipts(DEPENDENCY_WAKE_LIMITS.receipts) });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger()?.lastTick).toMatchObject({ complete: false, wakes: 0 });
    expect(h.ledger()?.audits.map((a) => a.outcome)).toContain("receipt_capacity");
    // Receipts whose blocker left the lookback no longer dedupe anything and make room.
    const stale = heldReceipts(DEPENDENCY_WAKE_LIMITS.receipts);
    for (const r of Object.values(stale)) r.blockerDoneAt = START - 8 * 1_440 * MIN;
    h.seed({ ...h.ledger()!, receipts: stale });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });

  it("resumes a budget-exhausted traversal so later candidates and both statuses are examined", async () => {
    const h = harness();
    const dep = h.issues[DEP]!;
    delete h.issues[DEP];
    for (let n = 0; n < 900; n += 1) h.issues[filler(n)] = { id: filler(n), companyId: COMPANY, status: "in_review", assigneeAgentId: AGENT, activeRun: null };
    h.issues[DEP] = dep;
    h.issues[DEP2] = { id: DEP2, companyId: COMPANY, status: "in_progress", assigneeAgentId: AGENT, activeRun: null };
    h.relations[DEP2] = [{ id: BLK, identifier: "TWO-1", status: "done" }];
    for (let n = 0; n < 3; n += 1) await h.runtime.poll();
    expect(h.ctx.issues.list.mock.calls.map(([query]) => query.status)).toContain("in_progress");
    expect(wokenIds(h).sort()).toEqual([DEP, DEP2]);
    expect(h.ledger()?.audits.map((a) => a.outcome)).toContain("tick_budget");
  });

  it("reports an incomplete tick when the wake budget defers eligible wakes, and wakes the rest next tick", async () => {
    const h = harness();
    for (let n = 0; n < 10; n += 1) {
      h.issues[filler(n)] = { id: filler(n), companyId: COMPANY, status: "in_review", assigneeAgentId: AGENT, activeRun: null };
      h.relations[filler(n)] = [{ id: BLK, identifier: "TWO-1", status: "done" }];
    }
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(10);
    expect(h.ledger()?.lastTick).toMatchObject({ complete: false, wakes: 10 });
    expect(h.ledger()?.audits.map((a) => a.outcome)).toContain("wake_budget");
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(11);
    expect(wokenIds(h).at(-1)).toBe(DEP);
  });

  it("retries a host-deferred wake next tick but never repeats an unconfirmed one", async () => {
    const deferred = harness();
    deferred.ctx.issues.requestWakeup.mockRejectedValueOnce(new Error("worker RPC host is not running"));
    await deferred.runtime.poll();
    expect(deferred.ledger()?.receipts).toEqual({});
    await deferred.runtime.poll();
    expect(deferred.ctx.issues.requestWakeup).toHaveBeenCalledTimes(2);
    expect(deferred.ledger()?.receipts[rk(DEP, BLK, DONE)]?.outcome).toBe("woken");
    const h = harness();
    h.ctx.issues.requestWakeup.mockRejectedValueOnce(new Error("boom"));
    await h.runtime.poll();
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
    expect(h.ledger()?.receipts[rk(DEP, BLK, DONE)]?.outcome).toBe("unconfirmed");
  });

  it("retries a confirmed non-queued wake on a later tick under the same epoch idempotency key", async () => {
    const h = harness();
    h.ctx.issues.requestWakeup
      .mockResolvedValueOnce({ queued: false, runId: null })
      .mockResolvedValueOnce({ queued: true, runId: "run-new" });
    await h.runtime.poll();
    // queued:false is a confirmed non-effect: the intent is released, not recorded.
    expect(h.ledger()?.receipts).toEqual({});
    expect(h.ledger()?.audits.map((a) => a.outcome)).toContain("host_deferred");
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(2);
    const keys = (h.ctx.issues.requestWakeup.mock.calls as unknown as Array<[string, string, { idempotencyKey: string }]>).map(([, , o]) => o.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(h.ledger()?.receipts[rk(DEP, BLK, DONE)]?.outcome).toBe("woken");
    // A stale not_queued receipt written by an older version must not keep suppressing either.
    const stale = harness();
    stale.seed({ version: 1, audits: [], receipts: { [rk(DEP, BLK, DONE)]: { at: START - 25 * MIN, outcome: "not_queued" as never, blockerDoneAt: DONE } } });
    await stale.runtime.poll();
    expect(stale.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });

  it("retries a definite pre-queue budget denial on a later tick under the same epoch idempotency key", async () => {
    const h = harness();
    h.ctx.issues.requestWakeup.mockRejectedValueOnce(new Error("Agent cannot start work while completed runs await accounting."));
    await h.runtime.poll();
    expect(h.ledger()?.receipts).toEqual({});
    expect(h.ledger()?.audits.map((a) => a.outcome)).toContain("host_deferred");
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(2);
    const keys = (h.ctx.issues.requestWakeup.mock.calls as unknown as Array<[string, string, { idempotencyKey: string }]>).map(([, , o]) => o.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(h.ledger()?.receipts[rk(DEP, BLK, DONE)]?.outcome).toBe("woken");
    // A post-dispatch budget observation is not proof a prior call never ran; but a definite
    // host pre-queue error must never be recorded unconfirmed.
    const denied = harness();
    denied.ctx.issues.requestWakeup.mockRejectedValueOnce(new Error("Company is paused because its budget hard-stop was reached."));
    await denied.runtime.poll();
    await denied.runtime.poll();
    expect(denied.ctx.issues.requestWakeup).toHaveBeenCalledTimes(2);
  });

  it("still wakes when the dependent's run started in the blocker's done-to-finalize window", async () => {
    const h = harness();
    // The blocker was marked done at T-30m but its finishing run ran until T-25m; a dependent
    // run started at T-27m saw neither the completion nor the finalized workspace.
    h.runs[BLK] = [{ id: "b1", issueId: BLK, agentId: REVIEWER, status: "succeeded", createdAt: iso(START - 45 * MIN), startedAt: iso(START - 45 * MIN), finishedAt: iso(START - 25 * MIN) }];
    h.runs[DEP]!.push({ id: "r2", issueId: DEP, agentId: AGENT, status: "succeeded", createdAt: iso(START - 27 * MIN), startedAt: iso(START - 27 * MIN), finishedAt: iso(START - 26 * MIN) });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
    // A run that started only after the blocker fully settled still counts as having seen it.
    const seen = harness();
    seen.runs[BLK] = [{ id: "b1", issueId: BLK, agentId: REVIEWER, status: "succeeded", createdAt: iso(START - 45 * MIN), startedAt: iso(START - 45 * MIN), finishedAt: iso(START - 25 * MIN) }];
    seen.runs[DEP]!.push({ id: "r2", issueId: DEP, agentId: AGENT, status: "succeeded", createdAt: iso(START - 24 * MIN), startedAt: iso(START - 24 * MIN), finishedAt: iso(START - 22 * MIN) });
    await seen.runtime.poll();
    expect(seen.ctx.issues.requestWakeup).not.toHaveBeenCalled();
    expect(seen.ledger()?.receipts).toEqual({});
  });

  it("bounds settlement by the completion epoch: a later unrelated blocker run does not re-trigger a seen completion", async () => {
    // B at T-30m, the completing run finishes T-25m, the dependent's assignee started a run at
    // T-20m (after settlement) — tick records no wake and no receipt. An unrelated blocker run
    // then starts T-15m and finishes T-10m: it could never have produced this completion, so a
    // later tick must still not wake. Max over every blocker run would wrongly advance the
    // settlement watermark to T-10m and re-fire the already-seen completion.
    const h = harness();
    h.runs[BLK] = [{ id: "b1", issueId: BLK, agentId: REVIEWER, status: "succeeded", createdAt: iso(START - 45 * MIN), startedAt: iso(START - 45 * MIN), finishedAt: iso(START - 25 * MIN) }];
    h.runs[DEP]!.push({ id: "r2", issueId: DEP, agentId: AGENT, status: "succeeded", createdAt: iso(START - 20 * MIN), startedAt: iso(START - 20 * MIN), finishedAt: iso(START - 18 * MIN) });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger()?.receipts).toEqual({});
    h.runs[BLK]!.push({ id: "b2", issueId: BLK, agentId: REVIEWER, status: "succeeded", createdAt: iso(START - 15 * MIN), startedAt: iso(START - 15 * MIN), finishedAt: iso(START - 10 * MIN) });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger()?.receipts).toEqual({});
  });

  it("still defers on a currently-live blocker run that started after the completion epoch", async () => {
    // The liveness check is all-agent and unfiltered by the epoch: a run that started after
    // completedAt cannot advance the settlement, but it may still be finalizing something a
    // woken assignee would need, so it defers on its own.
    const h = harness();
    h.runs[BLK]!.push({ id: "b2", issueId: BLK, agentId: REVIEWER, status: "running", createdAt: iso(START - 10 * MIN), startedAt: iso(START - 10 * MIN), finishedAt: null });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger()?.receipts).toEqual({});
    h.runs[BLK]![1]!.status = "succeeded";
    h.runs[BLK]![1]!.finishedAt = iso(START - 5 * MIN);
    h.runs[DEP]!.push({ id: "r2", issueId: DEP, agentId: AGENT, status: "succeeded", createdAt: iso(START - 3 * MIN), startedAt: iso(START - 3 * MIN), finishedAt: iso(START - 2 * MIN) });
    await h.runtime.poll();
    // Now finished, that later run still does not advance the seen-completion settlement.
    expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger()?.receipts).toEqual({});
  });

  it("does not let an older blocker whose settlement is unbounded suppress a newer settled one", async () => {
    // A completed T-30m but no run spans its epoch (bound unknown); B completed T-15m with a
    // valid spanning run. The dependent's assignee last ran at T-20m, so only B qualifies —
    // the wake fires for B alone and A stays unreceipted, retried on later ticks.
    const h = harness();
    h.runs[BLK] = [{ id: "b1", issueId: BLK, agentId: REVIEWER, status: "succeeded", createdAt: iso(START - 45 * MIN), startedAt: iso(START - 45 * MIN), finishedAt: iso(START - 35 * MIN) }];
    h.issues[BLK2] = { id: BLK2, companyId: COMPANY, status: "done", completedAt: iso(START - 15 * MIN) };
    h.runs[BLK2] = [{ id: "b2", issueId: BLK2, agentId: REVIEWER, status: "succeeded", createdAt: iso(START - 20 * MIN), startedAt: iso(START - 20 * MIN), finishedAt: iso(START - 15 * MIN) }];
    h.relations[DEP]!.push({ id: BLK2, identifier: "TWO-2", status: "done" });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
    const [, , options] = h.ctx.issues.requestWakeup.mock.calls[0] as unknown as [string, string, { reason: string }];
    expect(options.reason).toContain("TWO-2 done");
    expect(options.reason).not.toContain("TWO-1 done");
    expect(h.ledger()?.audits.map((a) => a.outcome)).toContain("blocker_settlement_unknown");
    expect(h.ledger()?.receipts[rk(DEP, BLK, DONE)]).toBeUndefined();
    expect(h.ledger()?.receipts[rk(DEP, BLK2, START - 15 * MIN)]?.outcome).toBe("woken");
    // A's epoch was never consumed: once its interval is bounded it still qualifies, so a
    // later tick wakes once for it as a distinct (dependent, blocker, epoch) event.
    h.runs[BLK]![0]!.finishedAt = iso(START - 30 * MIN);
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(2);
    const [, , options2] = h.ctx.issues.requestWakeup.mock.calls[1] as unknown as [string, string, { reason: string }];
    expect(options2.reason).toContain("TWO-1 done");
    // A dependent run started after A settled sees the completion and no further wake fires.
    h.runs[DEP]!.push({ id: "r2", issueId: DEP, agentId: AGENT, status: "succeeded", createdAt: iso(START - 10 * MIN), startedAt: iso(START - 10 * MIN), finishedAt: iso(START - 8 * MIN) });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(2);
  });

  it("still defers the whole dependent on a live run of an unrelated blocker", async () => {
    // Settlement unknown is per-blocker, but a live blocker run is the workspace-finalize
    // signal: it defers the dependent even when another blocker is settled.
    const h = harness();
    h.runs[BLK] = [{ id: "b1", issueId: BLK, agentId: REVIEWER, status: "running", createdAt: iso(START - 5 * MIN), startedAt: iso(START - 5 * MIN), finishedAt: null }];
    h.issues[BLK2] = { id: BLK2, companyId: COMPANY, status: "done", completedAt: iso(START - 15 * MIN) };
    h.runs[BLK2] = [{ id: "b2", issueId: BLK2, agentId: REVIEWER, status: "succeeded", createdAt: iso(START - 20 * MIN), startedAt: iso(START - 20 * MIN), finishedAt: iso(START - 15 * MIN) }];
    h.relations[DEP]!.push({ id: BLK2, identifier: "TWO-2", status: "done" });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger()?.receipts).toEqual({});
  });

  it("defers the whole dependent on a truncated blocker window: a hidden live run may exist", async () => {
    // Settlement unknown is per-blocker, but a full 100-run window cannot prove no older run is
    // still live, so it defers the dependent even when another blocker is settled.
    const h = harness();
    h.runs[BLK] = Array.from({ length: 100 }, (_, i) => ({ id: `b${i}`, issueId: BLK, agentId: REVIEWER, status: "succeeded", createdAt: iso(START - 40 * MIN + i * 1_000), startedAt: iso(START - 40 * MIN + i * 1_000), finishedAt: iso(START - 40 * MIN + i * 1_000 + 500) }));
    h.issues[BLK2] = { id: BLK2, companyId: COMPANY, status: "done", completedAt: iso(START - 15 * MIN) };
    h.runs[BLK2] = [{ id: "b2", issueId: BLK2, agentId: REVIEWER, status: "succeeded", createdAt: iso(START - 20 * MIN), startedAt: iso(START - 20 * MIN), finishedAt: iso(START - 15 * MIN) }];
    h.relations[DEP]!.push({ id: BLK2, identifier: "TWO-2", status: "done" });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger()?.audits.map((a) => a.outcome)).toContain("blocker_window_truncated");
    expect(h.ledger()?.receipts).toEqual({});
  });

  const receipted = (h: ReturnType<typeof harness>) => h.seed({ version: 1, audits: [], receipts: { [rk(DEP, BLK, DONE)]: { at: START - 25 * MIN, outcome: "woken", blockerDoneAt: DONE } } });
  const stale = (h: ReturnType<typeof harness>) => { h.issues[BLK]!.completedAt = iso(START - 8 * 1_440 * MIN); };
  const liveRun = (h: ReturnType<typeof harness>) => { h.runs[BLK]!.push({ id: "rv", issueId: BLK, agentId: REVIEWER, status: "running", createdAt: iso(START - 5 * MIN), startedAt: iso(START - 5 * MIN), finishedAt: null }); };
  const truncRun = (h: ReturnType<typeof harness>) => { h.runs[BLK] = Array.from({ length: 100 }, (_, i) => ({ id: `b${i}`, issueId: BLK, agentId: REVIEWER, status: "succeeded", createdAt: iso(START - 40 * MIN + i * 1_000), startedAt: iso(START - 40 * MIN + i * 1_000), finishedAt: iso(START - 40 * MIN + i * 1_000 + 500) })); };
  const addTrigger = (h: ReturnType<typeof harness>) => { h.issues[BLK2] = { id: BLK2, companyId: COMPANY, status: "done", completedAt: iso(START - 15 * MIN) };
    h.runs[BLK2] = [{ id: "b2", issueId: BLK2, agentId: REVIEWER, status: "succeeded", createdAt: iso(START - 20 * MIN), startedAt: iso(START - 20 * MIN), finishedAt: iso(START - 15 * MIN) }];
    h.relations[DEP]!.push({ id: BLK2, identifier: "TWO-2", status: "done" }); };
  const settledBlockers = (h: ReturnType<typeof harness>, depId: string, count: number, first = 0) => {
    const rels = (h.relations[depId] ??= []);
    for (let n = 0; n < count; n += 1) { // `count` done blockers settled T-30m
      const id = filler(first + n);
      h.issues[id] = { id, companyId: COMPANY, status: "done", completedAt: iso(START - 30 * MIN) };
      h.runs[id] = [{ id: `s${id}`, issueId: id, agentId: REVIEWER, status: "succeeded", createdAt: iso(START - 45 * MIN), startedAt: iso(START - 45 * MIN), finishedAt: iso(START - 30 * MIN) }];
      rels.push({ id, identifier: `TWO-${first + n}`, status: "done" });
    }
  };
  it("defers an eligible epoch while an excluded blocker is live or unbounded", async () => {
    for (const m of [liveRun, truncRun]) for (const exclude of [receipted, stale]) { // each exclusion mode x live / unbounded window
      const h = harness();
      m(h); exclude(h); addTrigger(h); await h.runtime.poll();
      expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
      expect(h.ledger()?.receipts[rk(DEP, BLK2, START - 15 * MIN)]).toBeUndefined();
      if (m !== liveRun) continue; // excluded live run finishes -> deferred epoch wakes once
      Object.assign(h.runs[BLK]!.at(-1)!, { status: "succeeded", finishedAt: iso(START - 4 * MIN) });
      await h.runtime.poll(); await h.runtime.poll(); // woken once, stays deduped
      expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
      expect(h.ledger()?.receipts[rk(DEP, BLK2, START - 15 * MIN)]?.outcome).toBe("woken");
    }
  });
  it("supports 400 blockers within the 805-read budget, then fails closed at 401", async () => {
    const h = harness();
    Object.assign(h.runs[DEP]![0]!, { createdAt: iso(START - 29 * MIN), startedAt: iso(START - 29 * MIN), finishedAt: iso(START - 28 * MIN) }); // last run T-29m: 399 seen
    h.relations[DEP] = []; settledBlockers(h, DEP, 399); addTrigger(h); await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
    const reads = h.ctx.issues.list.mock.calls.length + h.ctx.issues.relations.get.mock.calls.length + h.ctx.issues.get.mock.calls.length + h.ctx.issues.summaries.getOrchestration.mock.calls.length + h.ctx.config.get.mock.calls.length - 1;
    expect(reads).toBeLessThanOrEqual(805);
    expect(h.ctx.issues.summaries.getOrchestration.mock.calls.length).toBe(401); // one read each
    settledBlockers(h, DEP, 1, 999); await h.runtime.poll(); // a 401st blocker: fan-in defers
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
    expect(h.ledger()?.audits.map((a) => a.outcome)).toContain("blocker_fan_in");
    expect(h.ledger()?.lastTick?.complete).toBe(false); // incomplete, not a quiet pass
  });
  it("retries a candidate that ran out of the shared budget on a fresh tick", async () => {
    const h = harness();
    // An id-sorted-earlier candidate consumes the tick: 400 blockers settled before its last run, no trigger.
    const early = filler(0);
    h.issues[early] = { id: early, companyId: COMPANY, status: "in_review", assigneeAgentId: AGENT, activeRun: null };
    h.runs[early] = [{ id: "e1", issueId: early, agentId: AGENT, status: "succeeded", createdAt: iso(START - 10 * MIN), startedAt: iso(START - 10 * MIN), finishedAt: iso(START - 9 * MIN) }];
    settledBlockers(h, early, 400, 1000); await h.runtime.poll(); // DEP gets no reads
    expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger()?.audits.map((a) => a.outcome)).toContain("tick_budget");
    await h.runtime.poll(); // DEP completes on a fresh tick
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });
  it("uses the latest finish among multiple runs spanning the completion epoch", async () => {
    // Two runs overlap done-at T-30m and finish at T-28m and T-24m: settlement is T-24m, so a
    // dependent run started at T-26m (before the envelope closed) saw only a partial window and
    // still triggers; one started at T-22m saw the settled completion and does not.
    const inside = harness();
    inside.runs[BLK]!.push({ id: "b2", issueId: BLK, agentId: REVIEWER, status: "succeeded", createdAt: iso(START - 44 * MIN), startedAt: iso(START - 44 * MIN), finishedAt: iso(START - 24 * MIN) });
    inside.runs[BLK]![0]!.finishedAt = iso(START - 28 * MIN);
    inside.runs[DEP]!.push({ id: "r2", issueId: DEP, agentId: AGENT, status: "succeeded", createdAt: iso(START - 26 * MIN), startedAt: iso(START - 26 * MIN), finishedAt: iso(START - 25 * MIN) });
    await inside.runtime.poll();
    expect(inside.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
    const after = harness();
    after.runs[BLK]!.push({ id: "b2", issueId: BLK, agentId: REVIEWER, status: "succeeded", createdAt: iso(START - 44 * MIN), startedAt: iso(START - 44 * MIN), finishedAt: iso(START - 24 * MIN) });
    after.runs[BLK]![0]!.finishedAt = iso(START - 28 * MIN);
    after.runs[DEP]!.push({ id: "r2", issueId: DEP, agentId: AGENT, status: "succeeded", createdAt: iso(START - 22 * MIN), startedAt: iso(START - 22 * MIN), finishedAt: iso(START - 21 * MIN) });
    await after.runtime.poll();
    expect(after.ctx.issues.requestWakeup).not.toHaveBeenCalled();
  });

  it("fails closed when the completion epoch cannot be bounded by a valid spanning interval", async () => {
    const malformed: Array<[string, (runs: Array<Record<string, unknown>>) => void]> = [
      ["no runs at all", (runs) => { runs.length = 0; }],
      ["a run finished before the completion and none span it", (runs) => { runs[0]!.finishedAt = iso(START - 35 * MIN); }],
      ["a missing finish on the spanning run", (runs) => { runs[0]!.finishedAt = null; }],
      ["a malformed finish", (runs) => { runs[0]!.finishedAt = "not-a-date"; }],
      ["an inverted interval", (runs) => { runs[0]!.startedAt = iso(START - 20 * MIN); }],
      ["a malformed start", (runs) => { runs[0]!.startedAt = "not-a-date"; }],
    ];
    for (const [name, mutate] of malformed) {
      const h = harness();
      mutate(h.runs[BLK]!);
      await h.runtime.poll();
      expect(h.ctx.issues.requestWakeup, name).not.toHaveBeenCalled();
      expect(h.ledger()?.receipts ?? {}, name).toEqual({});
      expect(h.ledger()?.audits.map((a) => a.outcome), name).toContain("blocker_settlement_unknown");
    }
    // A never-started terminal run (reassignment-cancelled queue entry) is not completion
    // evidence, but it is not malformed either: a valid spanning run still bounds the epoch.
    const h = harness();
    h.runs[BLK]!.push({ id: "b2", issueId: BLK, agentId: REVIEWER, status: "cancelled", createdAt: iso(START - 20 * MIN), startedAt: null, finishedAt: iso(START - 19 * MIN) });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });

  it("survives a failed status list read and still sweeps the other status", async () => {
    const h = harness();
    h.issues[DEP]!.status = "in_progress";
    h.ctx.issues.list.mockImplementation(async ({ status, limit }: { status: string; limit?: number }) => {
      if (status === "in_review") throw new Error("host read failed");
      return Object.values(h.issues).filter((i) => i.status === status).slice(0, limit);
    });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
    expect(h.ledger()?.audits.map((a) => a.outcome)).toContain("status_list_error");
    expect(h.ledger()?.lastTick?.complete).toBe(false);
  });

  it("ignores other agents' runs for the watermark: a reviewer's run after the blocker finished is not the assignee seeing it", async () => {
    const h = harness();
    h.runs[DEP]!.push({ id: "rv", issueId: DEP, agentId: REVIEWER, status: "succeeded", createdAt: iso(START - 20 * MIN), startedAt: iso(START - 20 * MIN), finishedAt: iso(START - 15 * MIN) });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });

  it("treats a run window truncated by the host's 100-row cap as unknown evidence, not as the assignee never running", async () => {
    // Blocker done at T-30m; the assignee started a run at T-25m and so saw it.
    const reviewerRuns = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `rv${i}`, issueId: DEP, agentId: REVIEWER, status: "succeeded", createdAt: iso(START - 20 * MIN + i * 1_000), startedAt: iso(START - 20 * MIN + i * 1_000), finishedAt: iso(START - 20 * MIN + i * 1_000 + 500) }));
    for (const [n, audited] of [[99, false], [100, true]] as const) {
      const h = harness();
      Object.assign(h.runs[DEP]![0]!, { createdAt: iso(START - 25 * MIN), startedAt: iso(START - 25 * MIN), finishedAt: iso(START - 22 * MIN) });
      // Newer reviewer runs; at 100 they push the assignee's run out of the window.
      h.runs[DEP]!.push(...reviewerRuns(n));
      await h.runtime.poll();
      expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
      expect(h.ledger()?.receipts).toEqual({});
      expect(h.ledger()?.audits.map((a) => a.outcome).includes("run_window_truncated")).toBe(audited);
    }
  });

  it("fails closed on a full window even when every visible assignee run started before the blocker finished", async () => {
    // A truncated history hides only runs created earlier, but one of those could have been
    // queued long and started after the blocker finished: unknown, so audit rather than guess.
    const h = harness();
    h.runs[DEP]!.push(...Array.from({ length: 99 }, (_, i) => ({ id: `rv${i}`, issueId: DEP, agentId: REVIEWER, status: "succeeded", createdAt: iso(START - 80 * MIN + i * 1_000), startedAt: iso(START - 80 * MIN + i * 1_000), finishedAt: iso(START - 80 * MIN + i * 1_000 + 500) })));
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger()?.audits.map((a) => a.outcome)).toContain("run_window_truncated");
  });

  it("treats a genuine re-completion (new completedAt epoch) as a new event and wakes once for it", async () => {
    const h = harness();
    await h.runtime.poll();
    // The wake ran; the blocker was then reopened (completedAt cleared) and finished again.
    h.runs[DEP]!.push({ id: "run-new", issueId: DEP, agentId: AGENT, status: "succeeded", createdAt: iso(START - 28 * MIN), startedAt: iso(START - 28 * MIN), finishedAt: iso(START - 26 * MIN) });
    h.issues[BLK]!.completedAt = iso(START - 15 * MIN);
    // The new completion epoch has its own spanning run; the old run's interval does not bound it.
    h.runs[BLK]!.push({ id: "b2", issueId: BLK, agentId: REVIEWER, status: "succeeded", createdAt: iso(START - 18 * MIN), startedAt: iso(START - 18 * MIN), finishedAt: iso(START - 15 * MIN) });
    await h.runtime.poll();
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(2);
    const keys = (h.ctx.issues.requestWakeup.mock.calls as unknown as Array<[string, string, { idempotencyKey: string }]>).map(([, , o]) => o.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(Object.keys(h.ledger()!.receipts).sort()).toEqual([rk(DEP, BLK, DONE), rk(DEP, BLK, START - 15 * MIN)].sort());
  });

  it("never re-wakes the same completion epoch under stale-receipt cap pressure", async () => {
    const h = harness();
    // Cap-many newer receipts whose blockers left the lookback: eviction may drop only those.
    const stale = Object.fromEntries(Array.from({ length: DEPENDENCY_WAKE_LIMITS.receipts }, (_, i) => [rk(filler(i), BLK2, START - 8 * 1_440 * MIN), { at: START - MIN, outcome: "woken" as const, blockerDoneAt: START - 8 * 1_440 * MIN }]));
    h.seed({ version: 1, audits: [], receipts: { [rk(DEP, BLK, DONE)]: { at: START - 25 * MIN, outcome: "woken", blockerDoneAt: DONE, runId: "run-new" }, ...stale } });
    h.runs[DEP]!.push({ id: "run-new", issueId: DEP, agentId: AGENT, status: "cancelled", createdAt: iso(START - 25 * MIN), startedAt: null, finishedAt: iso(START - 24 * MIN) });
    for (let n = 0; n < 3; n += 1) await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger()?.receipts[rk(DEP, BLK, DONE)]?.outcome).toBe("woken");
    expect(Object.keys(h.ledger()!.receipts)).toHaveLength(DEPENDENCY_WAKE_LIMITS.receipts);
  });

  it("honors the global dryRun kill switch: no live wake, shadow evidence only, and a mid-tick dryRun aborts", async () => {
    for (const config of [{ ...live, dryRun: true }, { dependencyWakeEnabled: true, dependencyWakeShadow: false, dependencyWakeCompanyId: COMPANY }]) {
      const h = harness();
      h.setConfig(config);
      await h.runtime.poll();
      expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
      expect(h.ledger()).toBeUndefined();
      expect(h.ledger("shadow")?.receipts[rk(DEP, BLK, DONE)]?.outcome).toBe("would_wake");
    }
    const h = harness();
    h.ctx.config.get.mockResolvedValueOnce({ ...live }).mockResolvedValueOnce({ ...live, dryRun: true });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger()?.audits.map((a) => a.outcome)).toEqual(["configuration_changed"]);
  });

  it("aborts before the effect when a rollback lands mid-tick", async () => {
    const h = harness();
    h.ctx.config.get.mockResolvedValueOnce({ ...live }).mockResolvedValueOnce({ ...live, dependencyWakeShadow: true });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger()?.audits.map((a) => a.outcome)).toEqual(["configuration_changed"]);
    expect(h.ledger()?.receipts).toEqual({});
  });

  it("isolates a failing candidate read and keeps the tick going", async () => {
    const h = harness();
    h.ctx.issues.relations.get.mockRejectedValueOnce(new Error("Issue not found"));
    await h.runtime.poll();
    expect(h.ledger()?.audits.map((a) => a.outcome)).toEqual(["candidate_error"]);
    expect(h.ledger()?.lastTick?.complete).toBe(true);
  });

  it("fails closed when disabled, unscoped or configured for another company", async () => {
    for (const setup of [
      (h: ReturnType<typeof harness>) => h.runtime.setCompanyId(null),
      (h: ReturnType<typeof harness>) => h.setConfig({ ...live, dependencyWakeEnabled: false }),
      (h: ReturnType<typeof harness>) => h.setConfig({ ...live, dependencyWakeCompanyId: OTHER }),
    ]) {
      const h = harness();
      setup(h);
      await h.runtime.poll();
      expect(h.ctx.issues.list).not.toHaveBeenCalled();
      expect(h.ledger()).toBeUndefined();
    }
  });

  it("validates config at both layers: enabling requires the company id", () => {
    expect(validateDependencyWakeConfig({ dependencyWakeEnabled: true }).length).toBe(1);
    expect(validateDependencyWakeConfig(live)).toEqual([]);
    expect(validateCiConfig(live)).toEqual([]);
    expect(validateInstanceConfig(live, manifest.instanceConfigSchema!).valid).toBe(true);
    expect(validateInstanceConfig({ dependencyWakeEnabled: true }, manifest.instanceConfigSchema!).valid).toBe(false);
    expect(manifest.jobs?.find((job) => job.jobKey === "dependency-wake")?.schedule).toBe("*/5 * * * *");
  });
});
