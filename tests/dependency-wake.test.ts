import type { PluginContext } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { DEPENDENCY_WAKE_LIMITS, DependencyWakeRuntime, validateDependencyWakeConfig, type DependencyWakeLedger } from "../src/dependency-wake.js";

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

});
