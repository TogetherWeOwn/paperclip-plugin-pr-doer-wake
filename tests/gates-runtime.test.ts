import type { PluginContext } from "@paperclipai/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatesStatusRuntime } from "../src/gates-runtime.js";
import { CiGithubError } from "../src/ci-github.js";

const github = vi.hoisted(() => ({ createStatus: vi.fn() }));

vi.mock("../src/ci-github.js", () => ({
  CiGithub: class {
    async createCommitStatus(...args: unknown[]) { return github.createStatus(...args); }
  },
  CiGithubCache: class {},
  CiGithubError: class extends Error {
    constructor(public readonly code: string, public readonly status?: number) { super(`GitHub CI ${code}`); this.name = "CiGithubError"; }
  },
  GATES_CONTEXT: "paperclip/gates",
}));

vi.mock("../src/ci-auth.js", () => ({
  CiAppAuth: class {
    token() { throw new Error("app auth unused in bearer fixtures"); }
    invalidate() {}
  },
  GATES_PERMISSIONS: Object.freeze({ statuses: "write" }),
}));

const COMPANY = "11111111-1111-4111-8111-111111111111";
const RM = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const ISSUE = "44444444-4444-4444-8444-444444444444";
const REPO = "acme/widget";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const TOKEN_REF = { type: "secret_ref", secretId: "88888888-8888-4888-8888-888888888888" };
const START = 1_800_000_000_000;

const clone = <T>(value: T): T => structuredClone(value);

interface Ledger {
  version: 1;
  queue: Array<{ issueId: string; companyId: string; enqueuedAt: number; attempts: number; nextAttemptAt: number; missingPermissionAttempts?: number; shadowAttempts?: number }>;
  published: Record<string, { repo: string; sha: string; state: string | null; count: number; lastPublishedAt: number; lastMissingPermissionAt?: number; shadowed?: boolean; lastShadowAt?: number; watermarkDecidedAtMs?: number; watermarkInteractionId?: string }>;
  audits: Array<{ at: number; operation: string; outcome: string; companyId?: string; issueId?: string; repo?: string; sha?: string; state?: string }>;
}

function gatesConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: false, gatesStatusEnabled: true, gatesStatusShadow: false,
    releaseManagerAgentId: RM, allowedRepos: [REPO], githubTokenSecretRef: TOKEN_REF, ...overrides,
  };
}

function interaction(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "request_confirmation", status: "accepted",
    addresseeAgentId: RM, resolvedByAgentId: RM, title: `Merge ${REPO}#17?`,
    payload: { version: 1, prompt: `Merge ${REPO}#17?`, detailsMarkdown: `https://github.com/${REPO}/pull/17` },
    result: { outcome: "accepted", reason: `approved at exact head ${SHA_A}` }, ...overrides,
  };
}

function setup(options: { config?: Record<string, unknown>; interactions?: unknown[]; createStatus?: (...args: unknown[]) => unknown } = {}) {
  let durable: Ledger | null = null;
  let now = START;
  let interactions = options.interactions ?? [interaction()];
  let rawConfig = options.config ?? gatesConfig();
  const get = vi.fn(async () => clone(durable));
  const set = vi.fn(async (_key: unknown, value: unknown) => { durable = clone(value as Ledger); });
  const listInteractions = vi.fn(async () => clone(interactions));
  const resolveSecret = vi.fn(async () => "test-token-not-for-agent-output");
  const fetch = vi.fn(async () => ({ status: 201, headers: {}, body: JSON.stringify({ id: 1, context: "paperclip/gates", state: "success" }) }));
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = {
    state: { get, set }, config: { get: async () => clone(rawConfig) },
    issues: { listInteractions }, secrets: { resolve: resolveSecret }, http: { fetch }, logger,
  } as unknown as PluginContext;
  github.createStatus.mockImplementation(options.createStatus ?? (async () => ({ id: 1, context: "paperclip/gates", state: "success" })));
  const runtime = new GatesStatusRuntime(ctx, () => now);
  const event = (entityId = ISSUE, companyId = COMPANY) => ({ eventType: "issue.updated", entityId, companyId } as never);
  return {
    ctx, runtime, listInteractions, fetch, logger, event,
    advance: (ms: number) => { now += ms; },
    ledger: () => clone(durable!),
    seed: (ledger: Ledger) => { durable = clone(ledger); },
    setInteractions: (next: unknown[]) => { interactions = next; },
    setConfig: (next: Record<string, unknown>) => { rawConfig = next; },
    enqueue: async (issueId = ISSUE) => { await runtime.handleIssueUpdated(event(issueId)); },
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("gates status runtime", () => {
  it("writes no drain/intent audit when the queue is empty (disabled sweep is silent)", async () => {
    const h = setup({ config: gatesConfig({ gatesStatusEnabled: false }) });
    h.seed({ version: 1, queue: [], published: {}, audits: [] });
    await h.runtime.drain();
    expect(h.ledger().audits).toEqual([]);
    expect(h.ledger().queue).toEqual([]);
  });

  it("publishes success for an RM-accepted merge confirmation and drains the queue entry", async () => {
    const h = setup();
    await h.enqueue();
    expect(github.createStatus).toHaveBeenCalledTimes(1);
    expect(github.createStatus).toHaveBeenCalledWith(REPO, SHA_A, "success", expect.stringContaining("RM merge success"));
    expect(h.ledger().queue).toEqual([]);
    expect(h.ledger().published[`${REPO}:${SHA_A}`]).toMatchObject({ state: "success", count: 1 });
  });

  it("publishes nothing for a hold card accepted by the RM (non-merge acceptance is not merge authorization)", async () => {
    const hold = interaction({
      title: `Confirm we must NOT merge ${REPO}#17 at ${SHA_A}.`,
      payload: { version: 1, prompt: `Confirm we must NOT merge ${REPO}#17 at ${SHA_A}.`, acceptLabel: "Keep blocked", detailsMarkdown: `https://github.com/${REPO}/pull/17` },
    });
    const h = setup({ interactions: [hold] });
    await h.enqueue();
    expect(github.createStatus).not.toHaveBeenCalled();
    expect(h.ledger().audits.map((a) => a.outcome)).toContain("no_decision");
    expect(h.ledger().published[`${REPO}:${SHA_A}`]).toBeUndefined();
  });

  it("is a no-op while gatesStatusEnabled is false, with no ledger writes at all", async () => {
    const h = setup({ config: gatesConfig({ gatesStatusEnabled: false }) });
    await h.enqueue();
    expect(github.createStatus).not.toHaveBeenCalled();
    expect(h.ledger()).toBeNull();
  });

  it("shadow mode logs the would-be status without any POST", async () => {
    const h = setup({ config: gatesConfig({ gatesStatusShadow: true }) });
    await h.enqueue();
    expect(github.createStatus).not.toHaveBeenCalled();
    expect(h.ledger().audits.map((a) => a.outcome)).toContain("shadow");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("ignores a wrong resolver and rejects repos outside the allowlist", async () => {
    const h = setup({ interactions: [interaction({ resolvedByAgentId: OTHER })] });
    await h.enqueue();
    expect(github.createStatus).not.toHaveBeenCalled();

    const refused = setup({ interactions: [interaction({ title: "Merge other/project#3?", payload: { version: 1, prompt: "Merge other/project#3?", detailsMarkdown: "https://github.com/other/project/pull/3" } })] });
    await refused.enqueue();
    expect(github.createStatus).not.toHaveBeenCalled();
    expect(refused.ledger().audits.map((a) => a.outcome)).toContain("repo_refused");
  });

  it("publishes failure for expired and pending for superseded decisions", async () => {
    const expired = setup({ interactions: [interaction({ status: "expired", result: { outcome: "expired", reason: `expired at exact head ${SHA_A}` } })] });
    await expired.enqueue();
    expect(github.createStatus).toHaveBeenCalledWith(REPO, SHA_A, "failure", expect.any(String));

    const superseded = setup({ interactions: [interaction({ status: "cancelled", result: { outcome: "superseded_by_comment", reason: `superseded for head ${SHA_A}` } })] });
    await superseded.enqueue();
    expect(github.createStatus).toHaveBeenCalledWith(REPO, SHA_A, "pending", expect.any(String));
  });

  it("dedupes per repo+SHA+state and publishes again only on a state change", async () => {
    const h = setup();
    await h.enqueue();
    await h.enqueue(); // same accepted decision: deduped
    expect(github.createStatus).toHaveBeenCalledTimes(1);
    expect(h.ledger().audits.map((a) => a.outcome)).toContain("deduped");

    // Supersession flips the same SHA to pending: a new status is published.
    h.setInteractions([interaction({ status: "cancelled", result: { outcome: "superseded_by_newer_request", reason: `superseded for head ${SHA_A}` } })]);
    await h.enqueue();
    expect(github.createStatus).toHaveBeenCalledTimes(2);
    expect(github.createStatus).toHaveBeenLastCalledWith(REPO, SHA_A, "pending", expect.any(String));
    expect(h.ledger().published[`${REPO}:${SHA_A}`]).toMatchObject({ state: "pending", count: 2 });
  });

  it("publishes only the newest decision for a SHA when retained history contradicts, in both list orders, without replay flap", async () => {
    const olderSuccess = interaction({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "accepted",
      result: { outcome: "accepted", reason: `approved at exact head ${SHA_A}` },
      resolvedAt: "2026-11-10T10:00:00.000Z", updatedAt: "2026-11-10T10:00:00.000Z", createdAt: "2026-11-09T10:00:00.000Z",
    });
    const newerFailure = interaction({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "rejected",
      result: { outcome: "rejected", reason: `rejected at exact head ${SHA_A}` },
      resolvedAt: "2026-11-10T11:00:00.000Z", updatedAt: "2026-11-10T11:00:00.000Z", createdAt: "2026-11-10T09:00:00.000Z",
    });
    for (const history of [[olderSuccess, newerFailure], [newerFailure, olderSuccess]]) {
      github.createStatus.mockClear();
      const h = setup({ interactions: history });
      await h.enqueue();
      expect(github.createStatus).toHaveBeenCalledTimes(1);
      expect(github.createStatus).toHaveBeenCalledWith(REPO, SHA_A, "failure", expect.any(String));
      expect(h.ledger().published[`${REPO}:${SHA_A}`]).toMatchObject({ state: "failure", count: 1 });
      // An unchanged replay (any later issue.updated) publishes nothing more.
      await h.enqueue();
      expect(github.createStatus).toHaveBeenCalledTimes(1);
    }
  });

  it("publishes only the newest decision when an older rejection is followed by a newer acceptance, in both list orders", async () => {
    const olderFailure = interaction({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "rejected",
      result: { outcome: "rejected", reason: `rejected at exact head ${SHA_A}` },
      resolvedAt: "2026-11-10T10:00:00.000Z",
    });
    const newerSuccess = interaction({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", status: "accepted",
      result: { outcome: "accepted", reason: `approved at exact head ${SHA_A}` },
      resolvedAt: "2026-11-10T11:00:00.000Z",
    });
    for (const history of [[olderFailure, newerSuccess], [newerSuccess, olderFailure]]) {
      github.createStatus.mockClear();
      const h = setup({ interactions: history });
      await h.enqueue();
      expect(github.createStatus).toHaveBeenCalledTimes(1);
      expect(github.createStatus).toHaveBeenCalledWith(REPO, SHA_A, "success", expect.any(String));
      await h.enqueue();
      expect(github.createStatus).toHaveBeenCalledTimes(1);
    }
  });

  it("never lets a stale retained decision republish over the persisted watermark", async () => {
    const h = setup({
      interactions: [interaction({
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", status: "accepted",
        result: { outcome: "accepted", reason: `approved at exact head ${SHA_A}` },
        resolvedAt: "2026-11-10T11:00:00.000Z",
      })],
    });
    await h.enqueue();
    expect(github.createStatus).toHaveBeenCalledTimes(1);
    // History shrinks to only the older contradictory decision: still no republish.
    h.setInteractions([interaction({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "rejected",
      result: { outcome: "rejected", reason: `rejected at exact head ${SHA_A}` },
      resolvedAt: "2026-11-10T10:00:00.000Z",
    })]);
    await h.enqueue();
    expect(github.createStatus).toHaveBeenCalledTimes(1);
    expect(h.ledger().audits.map((a) => a.outcome)).toContain("stale_decision");
    expect(h.ledger().published[`${REPO}:${SHA_A}`]).toMatchObject({ state: "success", count: 1 });
  });

  it("advances the watermark on same-state dedupe across separate issues (D1,D3,D2 regression)", async () => {
    const issue1 = "55555555-5555-4555-8555-555555555555";
    const issue2 = "66666666-6666-4666-8666-666666666666";
    const issue3 = "77777777-7777-4777-8777-777777777777";
    const d1Id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const d3Id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const d2Id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const t1 = "2026-11-10T10:00:00.000Z";
    const t2 = "2026-11-10T11:00:00.000Z";
    const t3 = "2026-11-10T12:00:00.000Z";
    const d1 = interaction({
      id: d1Id, status: "rejected",
      result: { outcome: "rejected", reason: `rejected at exact head ${SHA_A}` },
      resolvedAt: t1,
    });
    const d3 = interaction({
      id: d3Id, status: "rejected",
      result: { outcome: "rejected", reason: `rejected at exact head ${SHA_A}` },
      resolvedAt: t3,
    });
    const d2 = interaction({
      id: d2Id, status: "accepted",
      result: { outcome: "accepted", reason: `approved at exact head ${SHA_A}` },
      resolvedAt: t2,
    });
    const h = setup({ interactions: [d1] });
    await h.enqueue(issue1);
    expect(github.createStatus).toHaveBeenCalledTimes(1);
    expect(github.createStatus).toHaveBeenLastCalledWith(REPO, SHA_A, "failure", expect.any(String));
    h.setInteractions([d3]);
    await h.enqueue(issue2);
    // Same-state dedupe must advance the persisted watermark to T3 without a POST.
    expect(github.createStatus).toHaveBeenCalledTimes(1);
    expect(h.ledger().published[`${REPO}:${SHA_A}`]).toMatchObject({
      state: "failure", count: 1,
      watermarkDecidedAtMs: Date.parse(t3), watermarkInteractionId: d3Id,
    });
    const persisted = h.ledger();
    // Reload from persisted state (fresh runtime) so in-memory state cannot mask the bug.
    const reloaded = setup({ interactions: [d2] });
    reloaded.seed(persisted);
    await reloaded.enqueue(issue3);
    expect(github.createStatus).toHaveBeenCalledTimes(1);
    expect(reloaded.ledger().audits.map((a) => a.outcome)).toContain("stale_decision");
    expect(reloaded.ledger().published[`${REPO}:${SHA_A}`]).toMatchObject({
      state: "failure", count: 1,
      watermarkDecidedAtMs: Date.parse(t3), watermarkInteractionId: d3Id,
    });
  });

  it("recovers shadow-deferred work via sweep-only drain after flipping shadow off, surviving maxAttempts and reload", async () => {
    const shadowIssue = "55555555-5555-4555-8555-555555555555";
    const h = setup({ config: gatesConfig({ gatesStatusShadow: true }) });
    await h.enqueue(shadowIssue);
    expect(github.createStatus).not.toHaveBeenCalled();
    expect(h.ledger().queue).toHaveLength(1);
    expect(h.ledger().queue[0]!.issueId).toBe(shadowIssue);
    for (let i = 0; i < 25; i += 1) {
      h.advance(1_000_000);
      await h.runtime.drain();
      expect(github.createStatus).not.toHaveBeenCalled();
    }
    expect(h.ledger().queue).toHaveLength(1);
    expect(h.ledger().queue[0]!.attempts).toBe(0);
    expect(h.ledger().queue[0]!.shadowAttempts).toBeGreaterThan(20);
    expect(h.ledger().audits.map((a) => a.outcome)).not.toContain("gave_up");
    // Runtime reconstruction from persisted state; flip only shadow off, then drain without any enqueue.
    const persisted = h.ledger();
    const live = setup({ config: gatesConfig({ gatesStatusShadow: false }) });
    live.seed(persisted);
    live.advance(30_000_000); // past the persisted shadow backoff
    await live.runtime.drain();
    expect(github.createStatus).toHaveBeenCalledTimes(1);
    expect(github.createStatus).toHaveBeenCalledWith(REPO, SHA_A, "success", expect.any(String));
    expect(live.ledger().queue).toEqual([]);
    expect(live.ledger().published[`${REPO}:${SHA_A}`]).toMatchObject({ state: "success", count: 1 });
    expect(live.ledger().published[`${REPO}:${SHA_A}`]!.shadowed).toBeUndefined();
    live.advance(1_000_000);
    await live.runtime.drain();
    expect(github.createStatus).toHaveBeenCalledTimes(1);
  });

  it("publishes distinct SHAs independently (unchanged-decision and distinct-SHA controls)", async () => {
    const h = setup({
      interactions: [
        interaction({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", result: { outcome: "accepted", reason: `approved at exact head ${SHA_A}` }, resolvedAt: "2026-11-10T10:00:00.000Z" }),
        interaction({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "rejected", result: { outcome: "rejected", reason: `rejected at exact head ${SHA_B}` }, resolvedAt: "2026-11-10T11:00:00.000Z" }),
      ],
    });
    await h.enqueue();
    expect(github.createStatus).toHaveBeenCalledTimes(2);
    expect(h.ledger().published[`${REPO}:${SHA_A}`]).toMatchObject({ state: "success", count: 1 });
    expect(h.ledger().published[`${REPO}:${SHA_B}`]).toMatchObject({ state: "failure", count: 1 });
  });

  it("retains shadow decisions and publishes them after the shadow→live flip, without a new decision", async () => {
    const h = setup({ config: gatesConfig({ gatesStatusShadow: true }) });
    await h.enqueue();
    expect(github.createStatus).not.toHaveBeenCalled();
    expect(h.ledger().published[`${REPO}:${SHA_A}`]).toMatchObject({ state: "success", shadowed: true, count: 0 });
    h.setConfig(gatesConfig({ gatesStatusShadow: false }));
    await h.enqueue();
    expect(github.createStatus).toHaveBeenCalledTimes(1);
    expect(github.createStatus).toHaveBeenCalledWith(REPO, SHA_A, "success", expect.any(String));
    expect(h.ledger().published[`${REPO}:${SHA_A}`]).toMatchObject({ state: "success", count: 1 });
    expect(h.ledger().published[`${REPO}:${SHA_A}`]!.shadowed).toBeUndefined();
  });

  it("never exhausts missing-permission retries: the entry survives past maxAttempts and publishes after the grant", async () => {
    let granted = false;
    const h = setup({
      createStatus: async () => {
        if (!granted) throw new CiGithubError("http", 403) as never;
        return { id: 2, context: "paperclip/gates", state: "success" };
      },
    });
    await h.enqueue();
    // More than GATES_LIMITS.maxAttempts (20) missing-permission retries.
    for (let i = 0; i < 25; i += 1) {
      h.advance(1_000_000); // past the capped 15-minute missing-permission backoff
      await h.runtime.drain();
    }
    expect(h.ledger().queue).toHaveLength(1);
    expect(h.ledger().queue[0]!.attempts).toBe(0);
    expect(h.ledger().queue[0]!.missingPermissionAttempts).toBeGreaterThan(20);
    expect(h.ledger().audits.map((a) => a.outcome)).not.toContain("gave_up");
    granted = true;
    h.advance(1_000_000); // past the capped 15-minute missing-permission backoff
    await h.runtime.drain();
    expect(h.ledger().queue).toEqual([]);
    expect(h.ledger().published[`${REPO}:${SHA_A}`]).toMatchObject({ state: "success", count: 1 });
  });

  it("never greens an uncited new push: a decision for SHA A produces no status for SHA B", async () => {
    const h = setup();
    await h.enqueue();
    expect(github.createStatus.mock.calls.every((call) => call[1] === SHA_A)).toBe(true);
    expect(h.ledger().published[`${REPO}:${SHA_B}`]).toBeUndefined();
  });

  it("fails closed with missing_permission: entry retained, cooldown, then publishes after the grant", async () => {
    let granted = false;
    const h = setup({
      createStatus: async () => {
        if (!granted) throw new CiGithubError("http", 403) as never;
        return { id: 2, context: "paperclip/gates", state: "success" };
      },
    });
    await h.enqueue();
    expect(github.createStatus).toHaveBeenCalledTimes(1);
    expect(h.ledger().audits.map((a) => a.outcome)).toContain("missing_permission");
    expect(h.ledger().queue).toHaveLength(1); // retained for retry, never dropped quietly
    expect(h.ledger().published[`${REPO}:${SHA_A}`]?.state).toBeNull();

    // Cooldown suppresses an immediate retry while still ungranted.
    h.advance(10_000);
    await h.runtime.drain();
    expect(github.createStatus).toHaveBeenCalledTimes(1);

    granted = true;
    h.advance(120_000);
    await h.runtime.drain();
    expect(github.createStatus).toHaveBeenCalledTimes(2);
    expect(h.ledger().queue).toEqual([]);
    expect(h.ledger().published[`${REPO}:${SHA_A}`]).toMatchObject({ state: "success", count: 1 });
  });

  it("stops at the 1,000-statuses-per-SHA cap but publishes under it", async () => {
    const base = { version: 1 as const, queue: [] as Ledger["queue"], published: {} as Ledger["published"], audits: [] as Ledger["audits"] };
    const under = setup();
    under.seed({ ...base, published: { [`${REPO}:${SHA_A}`]: { repo: REPO, sha: SHA_A, state: "failure", count: 999, lastPublishedAt: START } } });
    await under.enqueue();
    expect(github.createStatus).toHaveBeenCalledTimes(1);

    const capped = setup();
    capped.seed({ version: 1, queue: [], published: { [`${REPO}:${SHA_A}`]: { repo: REPO, sha: SHA_A, state: "failure", count: 1_000, lastPublishedAt: START } }, audits: [] });
    github.createStatus.mockClear();
    await capped.enqueue();
    expect(github.createStatus).not.toHaveBeenCalled();
    expect(capped.ledger().audits.map((a) => a.outcome)).toContain("cap_reached");
  });

  it("ignores non-issue events and retries a host read failure instead of dropping work", async () => {
    const h = setup();
    await h.runtime.handleIssueUpdated({ eventType: "issue.created", entityId: ISSUE, companyId: COMPANY } as never);
    expect(h.ledger()).toBeNull();

    let failures = 1;
    const flaky = setup();
    flaky.ctx.issues.listInteractions = (async () => {
      if (failures-- > 0) throw new Error("host unavailable");
      return [interaction()];
    }) as never;
    await flaky.enqueue();
    expect(flaky.ledger().queue).toHaveLength(1);
    flaky.advance(120_000);
    await flaky.runtime.drain();
    expect(github.createStatus).toHaveBeenCalledTimes(1);
    expect(flaky.ledger().queue).toEqual([]);
  });

  it("durably enqueues on a transient config-read failure and publishes on sweep without a new event", async () => {
    const h = setup();
    let failures = 2;
    h.ctx.config.get = (async () => {
      if (failures-- > 0) throw new Error("config host unavailable");
      return gatesConfig();
    }) as never;
    await h.enqueue();
    // The transient failure must not lose the event: the entry survives
    // for sweep retry instead of disappearing like the pre-fix path.
    expect(github.createStatus).not.toHaveBeenCalled();
    expect(h.ledger().queue).toHaveLength(1);
    h.advance(120_000);
    await h.runtime.drain();
    expect(github.createStatus).toHaveBeenCalledTimes(1);
    expect(github.createStatus).toHaveBeenCalledWith(REPO, SHA_A, "success", expect.any(String));
    expect(h.ledger().queue).toEqual([]);
    expect(h.ledger().published[`${REPO}:${SHA_A}`]).toMatchObject({ state: "success", count: 1 });
  });
});
