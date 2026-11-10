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
  queue: Array<{ issueId: string; companyId: string; enqueuedAt: number; attempts: number; nextAttemptAt: number }>;
  published: Record<string, { repo: string; sha: string; state: string | null; count: number; lastPublishedAt: number; lastMissingPermissionAt?: number }>;
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
  const rawConfig = options.config ?? gatesConfig();
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
    enqueue: async (issueId = ISSUE) => { await runtime.handleIssueUpdated(event(issueId)); },
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("gates status runtime", () => {
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

  it("is a no-op while gatesStatusEnabled is false", async () => {
    const h = setup({ config: gatesConfig({ gatesStatusEnabled: false }) });
    await h.enqueue();
    expect(github.createStatus).not.toHaveBeenCalled();
    expect(h.ledger().audits.map((a) => a.outcome)).toContain("skipped_disabled");
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
});
