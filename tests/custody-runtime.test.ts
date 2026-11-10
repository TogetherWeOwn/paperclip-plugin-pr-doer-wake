import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { CustodyPull } from "../src/custody-github.js";
import { CustodyGithub } from "../src/custody-github.js";
import { loadCustodyCards, type CustodyCard } from "../src/custody-reader.js";
import { CustodyRuntime } from "../src/custody-runtime.js";
import { CUSTODY_ORIGIN, DAY } from "../src/custody-policy.js";
vi.mock("../src/custody-reader.js", () => ({ loadCustodyCards: vi.fn() }));

const COMPANY = "aaaaaaaa-0000-4000-8000-000000000001";
const ISSUE = "bbbbbbbb-0000-4000-8000-000000000001";
const PROJECT = "cccccccc-0000-4000-8000-000000000001";
const CHILD = "dddddddd-0000-4000-8000-000000000001";
const NOW = Date.parse("2026-10-20T12:00:00Z");
function pull(patch: Partial<CustodyPull> = {}): CustodyPull {
  return { repo: "example/project", number: 42, headSha: "a".repeat(40), headBranch: `work/${ISSUE}`, headRepo: "example/project", author: "contributor", authorIsBot: false, state: "open", merged: false, body: "", title: "Change", createdAt: NOW - 20 * DAY, updatedAt: NOW - 10 * DAY, closedAt: null, mergedAt: null, ...patch };
}
function card(patch: Partial<CustodyCard> = {}): CustodyCard {
  return { id: ISSUE, companyId: COMPANY, projectId: PROJECT, identifier: "TASK-42", title: "Change", description: null, status: "in_progress", statusVersion: 2, assigneeAgentId: ISSUE, assigneeUserId: null, updatedAt: NOW - 10 * DAY, completedAt: null, cancelledAt: null, texts: [], ...patch };
}
function fixture(options: { cards?: CustodyCard[]; open?: CustodyPull[]; closed?: CustodyPull[]; dryRun?: boolean } = {}) {
  let now = NOW;
  const cards = options.cards ?? [card()];
  const config: Record<string, unknown> = { custodyEnabled: true, custodyDryRun: options.dryRun ?? false, custodyCompanyId: COMPANY, custodySummaryAgentId: PROJECT, custodyOrg: "example", custodyClosedSince: "2026-10-01T00:00:00Z", githubTokenSecretRef: { type: "secret_ref", secretId: PROJECT } };
  const state = new Map<string, any>();
  const docs = new Map<string, any>();
  const created: any[] = [];
  const keyOf = (key: any) => JSON.stringify(key);
  const ctx = {
    config: { get: vi.fn(async () => config) },
    state: {
      get: vi.fn(async (key: any) => structuredClone(state.get(keyOf(key)) ?? null)),
      set: vi.fn(async (key: any, value: any) => { state.set(keyOf(key), structuredClone(value)); }),
    },
    secrets: { resolve: vi.fn(async () => "synthetic-provider-token") },
    http: { fetch: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    projects: {
      get: vi.fn(async (id: string) => ({ id, companyId: COMPANY })),
      listWorkspaces: vi.fn(async (projectId: string) => [{ projectId, repoUrl: "https://github.com/example/project" }]),
    },
    issues: {
      get: vi.fn(async (id: string) => cards.find((c) => c.id === id) ?? created.find((c) => c.id === id) ?? null),
      list: vi.fn(async ({ originId }: any) => created.filter((c) => c.originId === originId)),
      create: vi.fn(async (input: any) => { const c = { ...input, id: CHILD }; created.push(c); return c; }),
      requestWakeup: vi.fn(async () => ({ queued: true, runId: ISSUE })),
      relations: { get: vi.fn(async (_id: string) => ({ blockedBy: [], blocks: [] })) },
      documents: {
        get: vi.fn(async (id: string) => docs.get(id) ?? null),
        upsert: vi.fn(async (input: any) => { docs.set(input.issueId, input); return input; }),
      },
    },
  };
  vi.mocked(loadCustodyCards).mockResolvedValue(cards);
  vi.spyOn(CustodyGithub.prototype, "repositories").mockResolvedValue(["example/project"]);
  const listing = vi.spyOn(CustodyGithub.prototype, "pulls").mockImplementation(async (_repo, status) => status === "open" ? options.open ?? [pull()] : options.closed ?? []);
  vi.spyOn(CustodyGithub.prototype, "pull").mockImplementation(async (_repo, number) => {
    const pr = [...(options.open ?? [pull()]), ...(options.closed ?? [])].find((p) => p.number === number)!;
    return { ...pr, baseBranch: "main", draft: false, mergeable: true };
  });
  const activity = vi.spyOn(CustodyGithub.prototype, "activity").mockResolvedValue(NOW - 8 * DAY);
  vi.spyOn(CustodyGithub.prototype, "closureTexts").mockResolvedValue([]);
  const runtime = new CustodyRuntime(ctx as unknown as PluginContext, () => now);
  const ledger = () => [...state.entries()].find(([key]) => key.includes("pr-custody-v1"))?.[1];
  return { ctx, config, cards, state, docs, created, runtime, ledger, listing, activity, advance: (ms: number) => { now += ms; }, restart: () => new CustodyRuntime(ctx as unknown as PluginContext, () => now) };
}
afterEach(() => { vi.restoreAllMocks(); vi.mocked(loadCustodyCards).mockReset(); });

describe("custody native effects", () => {
  it("saves evidence and wakes assigned open card with exactly the trigger key, once across restart", async () => {
    const h = fixture();
    await h.runtime.poll();
    expect(h.ctx.issues.create).not.toHaveBeenCalled();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledWith(ISSUE, COMPANY, expect.objectContaining({ reason: "pr_disposition_due", idempotencyKey: `example/project#42|idle|${NOW - 8 * DAY}` }));
    expect(h.docs.get(ISSUE).body).toContain("Head: " + "a".repeat(40));
    await h.restart().poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
    expect(h.ledger().report.complete).toBe(true);
  });
  it.each(["done", "cancelled", "backlog", "blocked"])("creates explicit todo child and wake for %s source", async (status) => {
    const h = fixture({ cards: [card({ status })] });
    // Terminal and idle can independently fire; make idle fresh for this scenario.
    h.activity.mockResolvedValue(NOW);
    if (status === "blocked") h.activity.mockResolvedValue(NOW - 8 * DAY);
    await h.runtime.poll();
    expect(h.ctx.issues.create).toHaveBeenCalledWith(expect.objectContaining({ status: "todo", parentId: ISSUE, assigneeAgentId: ISSUE, originKind: CUSTODY_ORIGIN }));
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledWith(CHILD, COMPANY, expect.objectContaining({ idempotencyKey: h.created[0].originId }));
  });
  it("routes unassigned source child to the configured summary owner", async () => {
    const h = fixture({ cards: [card({ assigneeAgentId: null })] });
    await h.runtime.poll();
    expect(h.created[0].assigneeAgentId).toBe(PROJECT);
  });
  it("routes unresolved blockers through one child, never source mutation", async () => {
    const h = fixture();
    h.ctx.issues.relations.get.mockImplementation(async (id) => ({ blockedBy: id === ISSUE ? [{ status: "in_progress" }] : [], blocks: [] } as any));
    await h.runtime.poll();
    expect(h.created[0].parentId).toBe(ISSUE);
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledWith(CHILD, COMPANY, expect.any(Object));
  });
  it("keeps dry run entirely free of card/document/wake effects and live keys separate", async () => {
    const h = fixture({ dryRun: true });
    await h.runtime.poll();
    expect(h.ctx.issues.create).not.toHaveBeenCalled();
    expect(h.ctx.issues.documents.upsert).not.toHaveBeenCalled();
    expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
    h.config.custodyDryRun = false;
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });
  it("never repeats an ambiguous wake and exposes the unconfirmed receipt", async () => {
    const h = fixture();
    h.ctx.issues.requestWakeup.mockRejectedValue(new Error("synthetic-provider-token must never be logged"));
    await h.runtime.poll();
    await h.restart().poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
    expect(Object.values(h.ledger().receipts)).toEqual([expect.objectContaining({ status: "unconfirmed" })]);
    expect(JSON.stringify([...h.state.values()])).not.toContain("synthetic-provider-token");
  });
  it("retries only a positively deferred native queue result", async () => {
    const h = fixture();
    h.ctx.issues.requestWakeup.mockResolvedValueOnce({ queued: false, runId: null } as any);
    await h.runtime.poll();
    await h.restart().poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(2);
  });
  it("stops before dispatch when the durable intent cannot be saved", async () => {
    const h = fixture();
    const original = h.ctx.state.set.getMockImplementation()!;
    h.ctx.state.set.mockImplementation(async (key, value) => {
      if (Object.values(value.receipts).some((r: any) => r.status === "attempting")) throw new Error("storage unavailable");
      return original(key, value);
    });
    await expect(h.runtime.poll()).rejects.toThrow("storage unavailable");
    expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
  });
  it("does not repeat creation after its reply is lost", async () => {
    const h = fixture({ cards: [card({ status: "done" })] });
    h.activity.mockResolvedValue(NOW);
    h.ctx.issues.create.mockRejectedValue(new Error("reply lost"));
    await h.runtime.poll();
    await h.restart().poll();
    expect(h.ctx.issues.create).toHaveBeenCalledTimes(1);
    expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
  });
  it("reuses an existing origin child rather than duplicating it", async () => {
    const h = fixture({ cards: [card({ status: "done" })] });
    h.activity.mockResolvedValue(NOW);
    h.created.push({ id: CHILD, companyId: COMPANY, status: "todo", assigneeAgentId: ISSUE, originKind: CUSTODY_ORIGIN, originId: `example/project#42|terminal|${ISSUE}:done:2` });
    await h.runtime.poll();
    expect(h.ctx.issues.create).not.toHaveBeenCalled();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });
  it("does not dispatch after company configuration is revoked mid-scan", async () => {
    const h = fixture();
    h.activity.mockImplementation(async () => { h.config.custodyEnabled = false; return NOW - 8 * DAY; });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
  });
  it("retains evidence for multiple PRs sharing one card", async () => {
    const h = fixture({ open: [pull(), pull({ number: 43 })] });
    await h.runtime.poll();
    expect(h.docs.get(ISSUE).body).toContain("example/project#42");
    expect(h.docs.get(ISSUE).body).toContain("example/project#43");
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(2);
  });
});

describe("coverage, summary and cursor controls", () => {
  it("records UNKNOWN, never absence, if the card snapshot fails", async () => {
    const h = fixture();
    vi.mocked(loadCustodyCards).mockRejectedValue(new Error("incomplete"));
    await h.runtime.poll();
    expect(h.ledger().report).toMatchObject({ complete: false, unknown: ["inventory"] });
    expect(h.ctx.secrets.resolve).not.toHaveBeenCalled();
    expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
  });
  it("retains closed cursor on denied activity but can act on independently proven terminal state", async () => {
    const h = fixture({ cards: [card({ status: "done" })] });
    h.activity.mockRejectedValue(new Error("partial GraphQL"));
    await h.runtime.poll();
    expect(h.ledger().report.complete).toBe(false);
    expect(h.ledger().cursors).toEqual({});
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });
  it("catches closures between polls from REST closed inventory, not only an open-set diff", async () => {
    const h = fixture({ open: [], closed: [pull({ state: "closed", closedAt: NOW - DAY })] });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledWith(ISSUE, COMPANY, expect.objectContaining({ idempotencyKey: `example/project#42|closed|${NOW - DAY}` }));
    expect(h.ledger().cursors["example/project"]).toBe(NOW);
    h.advance(DAY);
    await h.runtime.poll();
    expect(h.listing).toHaveBeenLastCalledWith("example/project", "closed", NOW);
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });
  it("creates one daily summary for unmapped, ambiguous and bot PRs, without per-PR cards", async () => {
    const h = fixture({ cards: [], open: [pull({ number: 41 }), pull({ number: 42, authorIsBot: true })] });
    await h.runtime.poll();
    await h.runtime.poll();
    expect(h.ctx.issues.create).toHaveBeenCalledTimes(1);
    expect(h.created[0]).toMatchObject({ assigneeAgentId: PROJECT, status: "todo", originId: "pr-custody-summary|2026-10-20" });
    expect(h.docs.get(CHILD).body).toContain("#41 open unmapped");
    expect(h.docs.get(CHILD).body).toContain("#42 open bot");
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });
  it("accumulates later unmapped closures in the same daily summary", async () => {
    const h = fixture({ cards: [], open: [], closed: [pull({ state: "closed", closedAt: NOW - DAY })] });
    await h.runtime.poll();
    h.listing.mockImplementation(async (_repo, state) => state === "closed" ? [pull({ number: 43, state: "closed", closedAt: NOW })] : []);
    await h.runtime.poll();
    expect(h.ctx.issues.create).toHaveBeenCalledTimes(1);
    expect(h.docs.get(CHILD).body).toContain("#42 closed unmapped");
    expect(h.docs.get(CHILD).body).toContain("#43 closed unmapped");
  });
  it("caps all trigger effects at 15, keeps cursor for undispatched closures and drains next tick", async () => {
    const h = fixture({ open: [], closed: Array.from({ length: 18 }, (_, i) => pull({ number: i + 1, state: "closed", closedAt: NOW - (20 - i) * 1000 })) });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(15);
    expect(h.ledger().cursors).toEqual({});
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(18);
    expect(h.ledger().cursors["example/project"]).toBe(NOW);
  });
  it("does not let ambiguous creation failures escape the 15-effect budget", async () => {
    const h = fixture({ cards: [card({ status: "done" })], open: Array.from({ length: 20 }, (_, i) => pull({ number: i + 1 })) });
    h.activity.mockResolvedValue(NOW);
    h.ctx.issues.create.mockRejectedValue(new Error("lost reply"));
    await h.runtime.poll();
    expect(h.ctx.issues.create).toHaveBeenCalledTimes(15);
  });
  it("persists a conservative head observation floor across restart, resetting it only for a new head", async () => {
    const pr = pull();
    const h = fixture({ open: [pr] });
    h.activity.mockImplementation(async (_pr, observedAt) => observedAt!);
    await h.runtime.poll();
    expect(h.activity).toHaveBeenLastCalledWith(pr, NOW);
    expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
    h.advance(3 * DAY);
    await h.restart().poll();
    expect(h.activity).toHaveBeenLastCalledWith(pr, NOW);
    pr.headSha = "b".repeat(40);
    await h.runtime.poll();
    expect(h.activity).toHaveBeenLastCalledWith(pr, NOW + 3 * DAY);
    h.advance(7 * DAY);
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });
  it("refuses a head or PR-state change between inventory and dispatch", async () => {
    const h = fixture();
    vi.mocked(CustodyGithub.prototype.pull).mockResolvedValue({ ...pull(), headSha: "b".repeat(40), baseBranch: "main", draft: false, mergeable: true });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger().report.complete).toBe(false);
  });
  it("retains same-second overlap for closures observed after a scan begins", async () => {
    const closed: CustodyPull[] = [];
    const h = fixture({ open: [], closed });
    h.advance(500);
    await h.runtime.poll();
    expect(h.ledger().cursors["example/project"]).toBe(NOW);
    closed.push(pull({ state: "closed", closedAt: NOW, updatedAt: NOW }));
    h.advance(500);
    await h.runtime.poll();
    expect(h.listing).toHaveBeenLastCalledWith("example/project", "closed", NOW);
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });
  it("reserves HTTP capacity for dispatch when activity inventory exhausts its share", async () => {
    const prs = Array.from({ length: 410 }, (_, i) => pull({ number: i + 1 }));
    const h = fixture({ open: prs });
    h.activity.mockImplementation(async function (this: any) {
      for (let i = 0; i < 3; i++) await this.fetch("https://api.github.com/graphql", { method: "POST" });
      return NOW - 8 * DAY;
    });
    vi.mocked(CustodyGithub.prototype.pull).mockImplementation(async function (this: any, _repo, number) {
      await this.fetch(`https://api.github.com/repos/example/project/pulls/${number}`);
      return { ...prs.find((p) => p.number === number)!, baseBranch: "main", draft: false, mergeable: true };
    });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(15);
    expect(h.ctx.http.fetch.mock.calls.length).toBeLessThanOrEqual(1_200);
    expect(h.ledger().report.complete).toBe(false);
  });
  it("does not refresh an unchanged description disposition after an unrelated card edit", async () => {
    const owner = card({ status: "done", texts: [{ body: "PR disposition: example/project#42 finish; next actor contributor; revisit event", at: NOW - 10 * DAY, ownership: true }] });
    const h = fixture({ cards: [owner] });
    h.activity.mockResolvedValue(NOW);
    h.ctx.issues.requestWakeup.mockResolvedValue({ queued: false, runId: null } as any);
    await h.runtime.poll();
    h.advance(DAY);
    owner.title = "An unrelated rename";
    owner.updatedAt = NOW + DAY;
    owner.texts[0]!.at = NOW + DAY;
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(2);
    expect(Object.values(h.ledger().receipts)).toEqual([expect.objectContaining({ status: "pending" })]);
  });
  it("acknowledges a terminal trigger when the same disposition is genuinely posted in a new comment", async () => {
    const body = "PR disposition: example/project#42 finish; next actor contributor; revisit event";
    const owner = card({ status: "done", texts: [{ id: "description", body, at: NOW - DAY, ownership: true }] });
    const h = fixture({ cards: [owner] });
    h.activity.mockResolvedValue(NOW);
    h.ctx.issues.requestWakeup.mockResolvedValue({ queued: false, runId: null } as any);
    await h.runtime.poll();
    h.advance(DAY);
    owner.texts.push({ id: `comment:${PROJECT}`, body, at: NOW + DAY, ownership: true });
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
    expect(Object.values(h.ledger().receipts)).toEqual([expect.objectContaining({ status: "cleared" })]);
  });
  it("refuses an existing child after its source is reassigned to another agent", async () => {
    const owner = card({ status: "done" });
    const h = fixture({ cards: [owner] });
    h.activity.mockResolvedValue(NOW);
    h.ctx.issues.requestWakeup.mockResolvedValueOnce({ queued: false, runId: null } as any);
    await h.runtime.poll();
    owner.assigneeAgentId = PROJECT;
    await h.runtime.poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
    expect(h.ctx.issues.create).toHaveBeenCalledTimes(1);
    expect(h.ledger().report.complete).toBe(false);
  });
  it.each([false, true])("keeps ambiguous closure %s coverage UNKNOWN without advancing the cursor", async (unmapped) => {
    const h = fixture({ cards: unmapped ? [] : [card()], open: [], closed: [pull({ state: "closed", closedAt: NOW - DAY })] });
    h.ctx.issues.requestWakeup.mockRejectedValue(new Error("reply lost"));
    await h.runtime.poll();
    expect(h.ledger().report.complete).toBe(false);
    expect(h.ledger().cursors).toEqual({});
    await h.restart().poll();
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
    expect(h.ledger().report.complete).toBe(false);
    expect(h.ledger().cursors).toEqual({});
  });
  it("coalesces overlapping scheduled callbacks", async () => {
    const h = fixture();
    await Promise.all([h.runtime.poll(), h.runtime.poll()]);
    expect(h.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
  });
});
