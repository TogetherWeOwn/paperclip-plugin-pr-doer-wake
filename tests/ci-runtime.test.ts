import { createHmac } from "node:crypto";
import type { PluginContext, PluginWebhookInput, ToolRunContext, ToolResult } from "@paperclipai/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseCiConfig, parseRegistration, validateCiConfig, workspaceRepo } from "../src/ci-config.js";
import { CiWakeRuntime, LIMITS, verifyCiSignature, type Wait } from "../src/ci-runtime.js";
import ciPlugin from "../src/ci-plugin.js";
import manifest, { registrationTool } from "../src/manifest.js";

const github = vi.hoisted(() => ({
  construct: vi.fn(),
  pull: vi.fn(),
  snapshot: vi.fn(),
  readiness: vi.fn(),
}));

vi.mock("../src/ci-github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ci-github.js")>();
  return {
    ...actual,
    CiGithub: class {
      constructor(...args: unknown[]) { github.construct(...args); }
      pull(...args: unknown[]) { return github.pull(...args); }
      snapshot(...args: unknown[]) { return github.snapshot(...args); }
    },
    // The runtime may retain a token-free cache, but never a token-bearing client.
    CiGithubCache: class {},
    evaluateReadiness: github.readiness,
  };
});

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const NEXT_RUN = "33333333-3333-4333-8333-333333333334";
const ISSUE = "44444444-4444-4444-8444-444444444444";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const WORKSPACE = "66666666-6666-4666-8666-666666666666";
const OTHER = "77777777-7777-4777-8777-777777777777";
const TOKEN_REF = { type: "secret_ref", secretId: "88888888-8888-4888-8888-888888888888" };
const WEBHOOK_REF = { type: "secret_ref", secretId: "99999999-9999-4999-8999-999999999999" };
const DELIVERY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NEXT_DELIVERY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
const REPO = "acme/widget";
const HEAD = "a".repeat(40);
const NEXT_HEAD = "b".repeat(40);
// Deliberately not an issue identifier: neither the branch nor PR text maps a card.
const BRANCH = "feature/opaque-branch";
const SECRET = "test-webhook-secret";
const TOKEN = "test-token-not-for-agent-output";
const START = 1_800_000_000_000;
const registration = { issueId: ISSUE, repo: REPO, prNumber: 17, headSha: HEAD };
const run = { companyId: COMPANY, agentId: AGENT, runId: RUN, projectId: PROJECT } as ToolRunContext;
const stateKey = { scopeKind: "instance", namespace: "ci-wake-v1", stateKey: "ledger" };

type Ledger = {
  version: 1;
  waits: Wait[];
  audits: Array<{ at: number; operation: string; outcome: string; waitId?: string }>;
  deliveries: Record<string, number>;
  hints: Record<string, number>;
  samples: Record<string, Array<{ sha: string; ms: number }>>;
};
const clone = <T>(value: T): T => structuredClone(value);
const waitData = (result: ToolResult) => result.data as { waitId: string; status: string; expiresAt: number };
function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { enabled: true, dryRun: false, allowedRepos: [REPO], githubTokenSecretRef: TOKEN_REF, webhooksEnabled: true, webhookSecretRef: WEBHOOK_REF, ...overrides };
}
function pull(overrides: Record<string, unknown> = {}) {
  return {
    repo: REPO, number: 17, headSha: HEAD, headRepo: REPO, headBranch: BRANCH,
    baseBranch: "main", state: "open", merged: false, draft: false, mergeable: true,
    author: "unrelated-login", ...overrides,
  };
}
function verdict(kind: "pending" | "pass" | "fail") {
  return {
    kind, failed: kind === "fail" ? ["build"] : [], missing: [], pending: kind === "pending" ? ["build"] : [],
    lastSuiteCompletedAt: null, missingSince: START, missingFailAt: null,
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(overrides: Record<string, unknown> = {}, runtimeOptions?: { secretResolveTimeoutMs?: number }) {
  let durable: Ledger | null = null;
  let now = START;
  let failWakingWrite = false;
  let commitWakingWrite = false;
  let failIntentWrite = false;
  let outcomeWriteError: Error | null = null;
  const rawConfig = config(overrides);
  const issue = {
    id: ISSUE, companyId: COMPANY, projectId: PROJECT, executionWorkspaceId: WORKSPACE,
    assigneeAgentId: AGENT, status: "in_progress", identifier: "CARD-123", title: "No PR linkage in this fixture",
    description: "No body links and no branch-name inference.",
  };
  const workspace = {
    id: WORKSPACE, companyId: COMPANY, projectId: PROJECT,
    repoUrl: "https://github.com/acme/widget.git", branchName: BRANCH,
  };
  const ownership = { agentId: AGENT, runId: RUN };
  // Clone both directions: mutations of a loaded ledger cannot bypass a failed write.
  const get = vi.fn(async (_key: unknown) => clone(durable));
  const writes: Ledger[] = [];
  const set = vi.fn(async (_key: unknown, value: unknown) => {
    const ledger = value as Ledger;
    writes.push(clone(ledger));
    if (failWakingWrite && ledger.waits.some((wait) => wait.status === "waking")) {
      failWakingWrite = false;
      if (commitWakingWrite) durable = clone(ledger);
      throw new Error("state unavailable before wake mark");
    }
    if (outcomeWriteError && ledger.waits.some((wait) => wait.status === "woken")) {
      const error = outcomeWriteError;
      outcomeWriteError = null;
      throw error;
    }
    if (failIntentWrite && ledger.audits.at(-1)?.outcome === "intent") {
      failIntentWrite = false;
      throw new Error("state unavailable before credential");
    }
    durable = clone(ledger);
  });
  const assertCheckoutOwner = vi.fn(async (input: { issueId: string; companyId: string; actorAgentId: string; actorRunId: string }) => {
    if (input.issueId !== ISSUE || input.companyId !== COMPANY || input.actorAgentId !== ownership.agentId || input.actorRunId !== ownership.runId) {
      throw new Error(`checkout refused; private host detail ${TOKEN}`);
    }
  });
  const requestWakeup = vi.fn(async (..._args: unknown[]): Promise<{ queued: boolean }> => ({ queued: true }));
  const issueGet = vi.fn(async (_id: string, _companyId: string) => clone(issue));
  const workspaceGet = vi.fn(async (_id: string, _companyId: string) => clone(workspace));
  const resolveSecret = vi.fn(async (ref: { secretId: string }, _options: unknown): Promise<string> => ref.secretId === WEBHOOK_REF.secretId ? SECRET : TOKEN);
  const fetch = vi.fn(async (..._args: unknown[]) => ({ status: 200, headers: {}, body: "{}" }));
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const configGet = vi.fn(async (_companyId: string) => clone(rawConfig));
  const ctx = {
    state: { get, set }, config: { get: configGet },
    issues: { get: issueGet, assertCheckoutOwner, requestWakeup },
    executionWorkspaces: { get: workspaceGet }, secrets: { resolve: resolveSecret }, http: { fetch }, logger,
  } as unknown as PluginContext;
  const runtime = new CiWakeRuntime(ctx, () => now, runtimeOptions);
  return {
    ctx, runtime, rawConfig, issue, workspace, ownership, get, set, writes, assertCheckoutOwner, requestWakeup,
    issueGet, workspaceGet, resolveSecret, fetch, logger, configGet,
    advance: (ms: number) => { now += ms; },
    clock: () => now,
    ledger: () => clone(durable!),
    seed: (ledger: Ledger) => { durable = clone(ledger); },
    failWakingWrite: (committed = false) => { failWakingWrite = true; commitWakingWrite = committed; },
    failIntentWrite: () => { failIntentWrite = true; },
    failOutcomeWrite: (error: Error) => { outcomeWriteError = error; },
  };
}

function signature(body: string, secret = SECRET) {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}
function webhook(options: {
  payload?: Record<string, unknown>; rawBody?: string; parsedBody?: unknown;
  signature?: string | null; event?: string; delivery?: string; endpointKey?: string;
} = {}): PluginWebhookInput {
  const rawBody = options.rawBody ?? JSON.stringify({
    action: "completed", organization: { login: "Acme" }, repository: { full_name: "Acme/Widget", owner: { login: "Acme" } },
    check_suite: { head_sha: HEAD, conclusion: "success", pull_requests: [] }, ...options.payload,
  });
  const headers: Record<string, string> = {
    "X-GitHub-Event": options.event ?? "check_suite", "X-GitHub-Delivery": options.delivery ?? DELIVERY,
  };
  if (options.signature !== null) headers["X-Hub-Signature-256"] = options.signature ?? signature(rawBody);
  return {
    endpointKey: options.endpointKey ?? "github-ci", headers, rawBody,
    parsedBody: options.parsedBody ?? { deliberately: "not the raw payload" }, requestId: OTHER,
  } as PluginWebhookInput;
}

beforeEach(() => {
  vi.resetAllMocks();
  github.pull.mockResolvedValue(pull());
  github.snapshot.mockResolvedValue({ suites: [], fixture: "snapshot comes only from GitHub, never from webhook conclusions" });
  github.readiness.mockReturnValue(verdict("pending"));
});

describe("native CI plugin entrypoint", () => {
  it("registers the native tool and job, and routes tool, poll and webhook handlers through one runtime", async () => {
    const h = setup();
    const registerTool = vi.fn<PluginContext["tools"]["register"]>();
    const registerJob = vi.fn<PluginContext["jobs"]["register"]>();
    Object.assign(h.ctx, { tools: { register: registerTool }, jobs: { register: registerJob } });
    const clock = vi.spyOn(Date, "now").mockImplementation(h.clock);
    try {
      await ciPlugin.definition.setup(h.ctx);
      expect(registerTool).toHaveBeenCalledTimes(1);
      expect(registerTool).toHaveBeenCalledWith("ci_wait_register", registrationTool, expect.any(Function));
      expect(registerJob).toHaveBeenCalledWith("ci-wake-poll", expect.any(Function));
      const tool = registerTool.mock.calls[0]![2];
      expect(registerJob).toHaveBeenCalledWith("pr-custody", expect.any(Function));
      const poll = registerJob.mock.calls.find(([key]) => key === "ci-wake-poll")![1];
      const job = { jobKey: "ci-wake-poll", runId: OTHER, trigger: "schedule" as const, scheduledAt: new Date(START).toISOString() };
      expect(await tool(registration, run)).toMatchObject({ data: { status: "open" } });
      await poll(job);
      expect(github.snapshot).toHaveBeenCalledTimes(1);
      expect(h.requestWakeup).not.toHaveBeenCalled();
      github.readiness.mockReturnValue(verdict("pass"));
      await ciPlugin.definition.onWebhook!(webhook());
      await poll(job);
      expect(github.snapshot).toHaveBeenCalledTimes(2);
      expect(h.requestWakeup).toHaveBeenCalledTimes(1);
      expect(h.ledger().waits).toHaveLength(1);
      expect(h.ledger().waits[0]?.status).toBe("woken");
    } finally {
      clock.mockRestore();
    }
  });

  it("exposes fail-closed native configuration validation", async () => {
    expect(await ciPlugin.definition.onValidateConfig!(config())).toEqual({ ok: true });
    expect(await ciPlugin.definition.onValidateConfig!(config({ githubTokenSecretRef: "plaintext" })))
      .toMatchObject({ ok: false, errors: expect.any(Array) });
  });

  it("accepts custody fields in the combined configuration without weakening either validator", async () => {
    expect(validateCiConfig(config({ custodyEnabled: false }))).toEqual([]);
    expect(await ciPlugin.definition.onValidateConfig!(config({ custodyEnabled: false }))).toEqual({ ok: true });
    expect(validateCiConfig(config({ custodyEnabled: true, custodyDryRun: false }))).toEqual([]);
    expect(await ciPlugin.definition.onValidateConfig!(config({
      custodyEnabled: true, custodyDryRun: false, custodyCompanyId: COMPANY,
      custodySummaryAgentId: AGENT, custodyOrg: "acme", custodyClosedSince: "2026-11-03T00:00:00Z",
    }))).toEqual({ ok: true });
    // Custody validation is not bypassed: enabling custody with missing sibling fields fails combined validation.
    expect(await ciPlugin.definition.onValidateConfig!(config({ custodyEnabled: true })))
      .toMatchObject({ ok: false, errors: expect.any(Array) });
    // Unknown fields and ambiguous authentication remain rejected.
    expect(validateCiConfig(config({ custodyEnabled: false, custodyTypo: true })).length).toBeGreaterThan(0);
    expect(validateCiConfig(config({ custodyEnabled: false, githubAppId: "123" })).length).toBeGreaterThan(0);
  });

  it("declares the explicit CI and custody capability envelopes without source status or comment mutation", () => {
    expect([...manifest.capabilities].sort()).toEqual([
      "agent.tools.register", "execution.workspaces.read", "http.outbound", "issues.checkout", "issues.read", "issues.wakeup",
      "jobs.schedule", "plugin.state.read", "plugin.state.write", "secrets.read-ref", "webhooks.receive",
      "issues.create", "issue.documents.read", "issue.documents.write", "issue.relations.read",
      "projects.read", "project.workspaces.read", "database.namespace.read", "database.namespace.migrate",
    ].sort());
    expect(manifest.tools).toEqual([registrationTool]);
    expect(registrationTool.parametersSchema).toMatchObject({ additionalProperties: false, required: ["issueId", "repo", "prNumber", "headSha"] });
    expect(manifest.jobs).toEqual([
      expect.objectContaining({ jobKey: "ci-wake-poll", schedule: "*/4 * * * *" }),
      expect.objectContaining({ jobKey: "pr-custody", schedule: "17 * * * *" }),
    ]);
    expect(manifest.capabilities).not.toContain("issues.update");
    expect(manifest.capabilities).not.toContain("issue.comments.create");
    expect(manifest.webhooks).toEqual([expect.objectContaining({ endpointKey: "github-ci" })]);
  });
});

describe("CI registration and configuration parsing", () => {
  it("defaults to disabled and dry-run, normalizes exact repository identities, and retains no plaintext credentials", () => {
    expect(parseCiConfig({})).toMatchObject({ enabled: false, dryRun: true, allowedRepos: [], githubTokenSecretRef: null });
    expect(parseCiConfig(config({ allowedRepos: ["Acme/Widget"], dryRun: "false", githubToken: "plaintext" })))
      .toMatchObject({ allowedRepos: [REPO], dryRun: true, githubTokenSecretRef: TOKEN_REF });
    expect(parseCiConfig(config())).not.toHaveProperty("githubToken");
    expect(validateCiConfig(config())).toEqual([]);
    expect(parseRegistration({ ...registration, repo: "Acme/Widget", issueId: ISSUE.toUpperCase() })).toEqual(registration);
  });

  it.each([
    null, [], "https://github.com/acme/widget/pull/17", {},
    { ...registration, body: "CARD-123" }, { ...registration, branch: BRANCH },
    { ...registration, issueId: "CARD-123" }, { ...registration, repo: "https://github.com/acme/widget" },
    { ...registration, repo: "acme/." }, { ...registration, repo: "acme/.." },
    { ...registration, repo: "acme/widget?token=secret" }, { ...registration, headSha: "abc1234" },
    { ...registration, headSha: HEAD.toUpperCase() }, { ...registration, prNumber: "17" },
    { ...registration, prNumber: 0 }, { ...registration, prNumber: 1.5 },
    { ...registration, prNumber: 2_147_483_648 },
  ])("refuses malformed or non-explicit registrations (%j)", (input) => {
    expect(() => parseRegistration(input)).toThrow("invalid_registration");
  });

  it.each([
    { allowedRepos: [] }, { allowedRepos: ["acme/widget", "bad repo"] }, { allowedRepos: Array(101).fill(REPO) },
    { allowedRepos: ["acme/.."] }, { githubTokenSecretRef: "plaintext" },
    { githubTokenSecretRef: { ...TOKEN_REF, token: TOKEN } },
    { githubTokenSecretRef: { ...TOKEN_REF, version: 0 } },
    { githubTokenSecretRef: { ...TOKEN_REF, secretId: "not-a-uuid" } },
    { webhookSecretRef: null }, { repoMedianMs: { [REPO]: 59_999 } },
    { repoMedianMs: { [REPO]: 86_400_001 } }, { repoMedianMs: { [REPO]: 60_000.5 } },
    { repoMedianMs: { "not a repo": 60_000 } }, { repoMedianMs: [] },
  ])("validates enabled configuration without accepting malformed secrets or allowlists (%j)", (overrides) => {
    expect(validateCiConfig(config(overrides)).length).toBeGreaterThan(0);
  });

  it("accepts bounded per-repository baselines and supported secret versions", () => {
    const parsed = parseCiConfig(config({
      githubTokenSecretRef: { ...TOKEN_REF, version: "latest" }, webhookSecretRef: { ...WEBHOOK_REF, version: 2 },
      repoMedianMs: { "Acme/Widget": 60_000, "acme/other": 86_400_000 },
    }));
    expect(parsed.repoMedianMs).toEqual({ [REPO]: 60_000, "acme/other": 86_400_000 });
    expect(parsed.githubTokenSecretRef?.version).toBe("latest");
    expect(validateCiConfig({ enabled: false })).toEqual([]);
  });

  it.each([
    ["https://github.com/Acme/Widget.git", REPO], ["git@github.com:Acme/Widget.git", REPO],
    ["https://github.com/acme/widget", REPO], [null, null],
    ["https://github.com.evil/acme/widget", null], ["https://user:pass@github.com/acme/widget", null],
    ["https://github.com/acme/widget?x=1", null], ["https://github.com/acme/widget#main", null],
    ["http://github.com/acme/widget", null], ["ssh://git@github.com/acme/widget", null],
    ["https://github.com/acme/widget/", null], ["https://gitlab.com/acme/widget", null],
  ])("maps only an exact trusted workspace repository URL (%s)", (url, expected) => {
    expect(workspaceRepo(url)).toBe(expected);
  });
});

describe("CI runtime registration authorization", () => {
  it("registers with an explicit custody flag in the combined configuration", async () => {
    const h = setup({ custodyEnabled: false });
    const result = await h.runtime.register(registration, run);
    expect(result).toMatchObject({ content: "CI wait registered", data: { status: "open", dryRun: false, expiresAt: START + LIMITS.waitMs } });
  });

  it("registers an explicit card/repository/PR/SHA tuple, bound to checkout and execution workspace", async () => {
    const h = setup();
    const result = await h.runtime.register(registration, run);
    expect(result).toMatchObject({ content: "CI wait registered", data: { status: "open", dryRun: false, expiresAt: START + LIMITS.waitMs } });
    expect(h.assertCheckoutOwner).toHaveBeenCalledTimes(2);
    expect(h.assertCheckoutOwner).toHaveBeenCalledWith({ issueId: ISSUE, companyId: COMPANY, actorAgentId: AGENT, actorRunId: RUN });
    expect(h.issueGet).toHaveBeenCalledWith(ISSUE, COMPANY);
    expect(h.workspaceGet).toHaveBeenCalledWith(WORKSPACE, COMPANY);
    expect(h.resolveSecret).toHaveBeenCalledWith(TOKEN_REF, { companyId: COMPANY, configPath: "githubTokenSecretRef" });
    expect(github.pull).toHaveBeenCalledWith(REPO, 17);
    expect(h.ledger().waits).toEqual([expect.objectContaining({ ...registration, companyId: COMPANY, projectId: PROJECT, workspaceId: WORKSPACE, branch: BRANCH, runId: RUN, status: "open" })]);
    expect(h.ledger().audits.map((entry) => entry.outcome)).toEqual(["intent", "registered"]);
    expect(h.get).toHaveBeenCalledWith(stateKey);
    expect(h.set).toHaveBeenCalledWith(stateKey, expect.any(Object));
    expect(h.set.mock.invocationCallOrder[0]!).toBeLessThan(h.resolveSecret.mock.invocationCallOrder[0]!);
    expect(h.requestWakeup).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(h.ledger())).not.toContain(TOKEN);
  });

  it.each(["agent", "run"] as const)("rejects the wrong checkout %s before resolving a secret", async (owner) => {
    const h = setup();
    h.ownership[owner === "agent" ? "agentId" : "runId"] = OTHER;
    const result = await h.runtime.register(registration, run);
    expect(result).toHaveProperty("error");
    expect(JSON.stringify(result)).not.toContain("private host detail");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(h.resolveSecret).not.toHaveBeenCalled();
    expect(github.construct).not.toHaveBeenCalled();
    expect(h.ledger().waits).toEqual([]);
  });

  it.each(["companyId", "agentId", "runId", "projectId"] as const)("refuses a malformed run %s", async (field) => {
    const h = setup();
    expect(await h.runtime.register(registration, { ...run, [field]: "untrusted" })).toHaveProperty("error");
    expect(h.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(h.resolveSecret).not.toHaveBeenCalled();
  });

  it.each([
    ["issue tenant", (h: ReturnType<typeof setup>) => { h.issue.companyId = OTHER; }],
    ["issue project", (h: ReturnType<typeof setup>) => { h.issue.projectId = OTHER; }],
    ["missing execution workspace", (h: ReturnType<typeof setup>) => { h.issue.executionWorkspaceId = ""; }],
    ["workspace tenant", (h: ReturnType<typeof setup>) => { h.workspace.companyId = OTHER; }],
    ["workspace project", (h: ReturnType<typeof setup>) => { h.workspace.projectId = OTHER; }],
    ["workspace repository", (h: ReturnType<typeof setup>) => { h.workspace.repoUrl = "https://github.com/acme/other.git"; }],
    ["workspace repository alias", (h: ReturnType<typeof setup>) => { h.workspace.repoUrl = "https://github.com.evil/acme/widget"; }],
  ] as const)("refuses a mismatched %s before credential access", async (_name, mutate) => {
    const h = setup();
    mutate(h);
    expect(await h.runtime.register(registration, run)).toHaveProperty("error");
    expect(h.resolveSecret).not.toHaveBeenCalled();
    expect(h.ledger().waits).toEqual([]);
  });

  it.each([
    { headSha: NEXT_HEAD }, { headRepo: "attacker/widget" }, { number: 18 },
    { state: "closed" }, { merged: true }, { headRepo: null },
  ])("refuses a PR that does not match the registered live head and workspace (%j)", async (overrides) => {
    const h = setup();
    github.pull.mockResolvedValue(pull(overrides));
    expect(await h.runtime.register(registration, run)).toHaveProperty("error");
    expect(h.ledger().waits).toEqual([]);
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });

  it("records branchVerified binding proof when the workspace branch equals the PR head branch", async () => {
    const h = setup();
    const result = await h.runtime.register(registration, run);
    expect(result).not.toHaveProperty("error");
    expect(h.ledger().waits).toHaveLength(1);
    expect(h.ledger().waits[0]).toMatchObject({ branchVerified: true });
  });

  it("registers when the workspace branch differs from the PR head branch", async () => {
    // Real agents push HEAD:<pr-branch> from work/<uuid> checkouts; binding
    // is PR number + exact head SHA, never branch-name equality. Such
    // repo-only registrations are recorded unverified for custody.
    const h = setup();
    h.workspace.branchName = "work/11111111-2222-3333-4444-555555555555";
    github.pull.mockResolvedValue(pull({ headBranch: "fix/actual-pr-branch" }));
    const result = await h.runtime.register(registration, run);
    expect(result).not.toHaveProperty("error");
    expect(result).toMatchObject({ content: "CI wait registered", data: { status: "open" } });
    expect(h.ledger().waits).toHaveLength(1);
    expect(h.ledger().waits[0]).toMatchObject({ branchVerified: false });
  });

  it("rechecks checkout ownership and workspace after the GitHub read", async () => {
    const h = setup();
    github.pull.mockImplementationOnce(async () => { h.ownership.runId = OTHER; return pull(); });
    expect(await h.runtime.register(registration, run)).toHaveProperty("error");
    expect(h.assertCheckoutOwner).toHaveBeenCalledTimes(2);
    expect(h.ledger().waits).toEqual([]);
  });

  it("registers when the workspace branch changes while GitHub answered", async () => {
    const h = setup();
    github.pull.mockImplementationOnce(async () => { h.workspace.branchName = "feature/moved"; return pull(); });
    expect(await h.runtime.register(registration, run)).toMatchObject({ content: "CI wait registered", data: { status: "open" } });
    expect(h.ledger().waits).toHaveLength(1);
    // The branch moved mid-read so the proof cannot hold: fail closed.
    expect(h.ledger().waits[0]).toMatchObject({ branchVerified: false });
  });

  it.each([
    { enabled: false }, { allowedRepos: ["acme/other"] }, { allowedRepos: ["bad repo"] },
    { githubTokenSecretRef: { ...TOKEN_REF, plaintext: TOKEN } },
  ])("fails closed for disabled, disallowed, or malformed configuration (%j)", async (overrides) => {
    const h = setup(overrides);
    expect(await h.runtime.register(registration, run)).toHaveProperty("error");
    expect(h.resolveSecret).not.toHaveBeenCalled();
    expect(h.ledger().waits).toEqual([]);
  });

  it("refuses extra registration keys before checkout or credential access", async () => {
    const h = setup();
    expect(await h.runtime.register({ ...registration, body: "https://github.com/acme/widget/pull/17" }, run)).toHaveProperty("error");
    expect(h.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(h.resolveSecret).not.toHaveBeenCalled();
  });

  it("does not resolve a credential when durable registration intent cannot be saved", async () => {
    const h = setup();
    h.failIntentWrite();
    expect(await h.runtime.register(registration, run)).toHaveProperty("error");
    expect(h.resolveSecret).not.toHaveBeenCalled();
    expect(github.pull).not.toHaveBeenCalled();
    expect(h.ledger().waits).toEqual([]);
  });

  it.each([
    ["checkout denial", (h: ReturnType<typeof setup>) => { h.ownership.runId = OTHER; }, "checkout_refused"],
    ["disallowed repository", (h: ReturnType<typeof setup>) => { h.rawConfig.allowedRepos = ["acme/other"]; }, "repo_refused"],
    ["disabled plugin", (h: ReturnType<typeof setup>) => { h.rawConfig.enabled = false; }, "plugin_disabled"],
    ["PR head mismatch", (h: ReturnType<typeof setup>) => { github.pull.mockResolvedValue(pull({ headSha: NEXT_HEAD })); }, "pr_binding_refused"],
    ["malformed registration", (h: ReturnType<typeof setup>) => { void h; }, "invalid_registration"],
  ] as const)("returns the enumerated secret-free refusal code for %s", async (_name, arrange, code) => {
    const h = setup();
    arrange(h);
    const params = code === "invalid_registration" ? { ...registration, extra: true } : registration;
    const result = await h.runtime.register(params, run);
    expect(result).toMatchObject({ error: `CI registration refused: ${code}`, data: { code } });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("private host detail");
    expect(h.ledger().audits.at(-1)).toMatchObject({ operation: "register", outcome: code });
    expect(h.ledger().waits).toEqual([]);
  });

  it("maps GitHub client failures to github_<code> without leaking upstream detail", async () => {
    const { CiGithubError } = await import("../src/ci-github.js");
    const h = setup();
    github.pull.mockRejectedValue(new CiGithubError("auth"));
    const result = await h.runtime.register(registration, run);
    expect(result).toMatchObject({ error: "CI registration refused: github_auth", data: { code: "github_auth" } });
    expect(h.ledger().waits).toEqual([]);
  });

  it("folds unknown host failures into registration_refused without leaking detail", async () => {
    const h = setup();
    github.pull.mockRejectedValue(new Error(`unexpected host detail ${TOKEN}`));
    const result = await h.runtime.register(registration, run);
    expect(result).toMatchObject({ error: "CI registration refused: registration_refused", data: { code: "registration_refused" } });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("unexpected host detail");
  });

  it("returns invalid_ledger without saving over a malformed persisted ledger", async () => {
    const h = setup();
    h.seed({ version: 1, waits: [], audits: [] } as unknown as Ledger);
    const result = await h.runtime.register(registration, run);
    expect(result).toMatchObject({ error: "CI registration refused: invalid_ledger", data: { code: "invalid_ledger" } });
    expect(h.set).not.toHaveBeenCalled();
    expect(h.assertCheckoutOwner).not.toHaveBeenCalled();
  });
});

describe("CI runtime polling and durable wake outcomes", () => {
  it("does nothing without an explicit registration, even if GitHub would report a terminal failure", async () => {
    const h = setup();
    github.readiness.mockReturnValue(verdict("fail"));
    await h.runtime.poll();
    expect(h.resolveSecret).not.toHaveBeenCalled();
    expect(github.pull).not.toHaveBeenCalled();
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });

  it("leaves pending checks open without waking or writing terminal audit", async () => {
    const h = setup({ repoMedianMs: { [REPO]: 120_000 } });
    await h.runtime.register(registration, run);
    h.advance(60_000);
    await h.runtime.poll();
    expect(h.ledger().waits[0]?.status).toBe("open");
    expect(h.requestWakeup).not.toHaveBeenCalled();
    expect(github.snapshot).toHaveBeenCalledWith(REPO, HEAD, "main");
    expect(github.readiness).toHaveBeenCalledWith(expect.anything(), { registeredAt: START, now: START + 60_000, medianMs: 120_000 });
    expect(h.ledger().audits.filter((entry) => entry.operation === "wake")).toEqual([]);
  });

  it.each(["pass", "fail"] as const)("wakes once for CI %s with stable per-wait idempotency and survives restart", async (kind) => {
    const h = setup();
    await h.runtime.register(registration, run);
    const wait = h.ledger().waits[0]!;
    github.readiness.mockReturnValue(verdict(kind));
    await h.runtime.poll();
    await h.runtime.poll();
    const restarted = new CiWakeRuntime(h.ctx, h.clock);
    await restarted.poll();
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
    expect(h.requestWakeup).toHaveBeenCalledWith(ISSUE, COMPANY, {
      reason: expect.stringContaining(`CI ${kind} ${REPO}@aaaaaaa`), contextSource: "plugin.ci-wake",
      idempotencyKey: `ci-wake:${REPO}:${HEAD}:${wait.waitId}`,
    });
    expect(h.ledger().waits[0]).toMatchObject({ status: "woken", finishedAt: START });
    expect(h.ledger().audits.filter((entry) => entry.operation === "wake").map((entry) => entry.outcome)).toEqual(["intent", "woken"]);
    const markCall = h.writes.findIndex((ledger) => ledger.waits.some((entry) => entry.status === "waking"));
    expect(markCall).toBeGreaterThanOrEqual(0);
    expect(h.set.mock.invocationCallOrder[markCall]!).toBeLessThan(h.requestWakeup.mock.invocationCallOrder[0]!);
  });

  it("records and logs would-wake in dry-run without any host wake effect", async () => {
    const h = setup({ dryRun: true });
    await h.runtime.register(registration, run);
    github.readiness.mockReturnValue(verdict("pass"));
    await h.runtime.poll();
    await h.runtime.poll();
    expect(h.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger().waits[0]?.status).toBe("would_wake");
    expect(h.ledger().audits.at(-1)).toMatchObject({ operation: "wake", outcome: "would_wake" });
    expect(h.logger.info).toHaveBeenCalledTimes(1);
    expect(h.logger.info).toHaveBeenCalledWith("ci-wake: would wake", expect.objectContaining({ repo: REPO, headSha: HEAD, verdict: "pass" }));
  });

  it.each([
    { headSha: NEXT_HEAD }, { headRepo: "fork/widget" },
    { state: "closed" }, { merged: true },
  ])("retires an obsolete registration rather than waking the old head (%j)", async (overrides) => {
    const h = setup();
    await h.runtime.register(registration, run);
    github.pull.mockResolvedValue(pull(overrides));
    github.readiness.mockReturnValue(verdict("fail"));
    await h.runtime.poll();
    expect(h.ledger().waits[0]).toMatchObject({ status: "retired", reason: "head_moved_or_closed" });
    expect(github.snapshot).not.toHaveBeenCalled();
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });

  it.each([{ headSha: NEXT_HEAD }, { baseBranch: "release" }])("rechecks the live PR immediately before wake and refuses changes (%j)", async (overrides) => {
    const h = setup();
    await h.runtime.register(registration, run);
    github.readiness.mockReturnValue(verdict("pass"));
    github.pull.mockResolvedValueOnce(pull()).mockResolvedValueOnce(pull(overrides));
    await h.runtime.poll();
    expect(h.ledger().waits[0]?.status).toBe("retired");
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });

  it.each(["tenant", "project", "repository", "workspace"] as const)("revalidates the card's %s binding before a wake", async (change) => {
    const h = setup();
    await h.runtime.register(registration, run);
    github.readiness.mockReturnValue(verdict("pass"));
    if (change === "tenant") h.issue.companyId = OTHER;
    if (change === "project") h.issue.projectId = OTHER;
    if (change === "repository") h.workspace.repoUrl = "https://github.com/acme/other";
    if (change === "workspace") { h.issue.executionWorkspaceId = OTHER; h.workspace.id = OTHER; }
    await h.runtime.poll();
    expect(h.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger().waits[0]?.status).toBe(change === "tenant" ? "open" : "retired");
    if (change !== "tenant") {
      expect(h.ledger().waits[0]).toMatchObject({ reason: "binding_changed", finishedAt: START });
      expect(h.ledger().audits.at(-1)).toMatchObject({ operation: "poll", outcome: "binding_changed" });
      const attempts = github.pull.mock.calls.length;
      await h.runtime.poll();
      expect(github.pull).toHaveBeenCalledTimes(attempts);
    }
  });

  it.each(["issue", "workspace"] as const)("keeps the wait retryable after a transient %s read failure", async (target) => {
    const h = setup();
    await h.runtime.register(registration, run);
    github.readiness.mockReturnValue(verdict("pass"));
    const read = target === "issue" ? h.issueGet : h.workspaceGet;
    read.mockRejectedValueOnce(new Error("temporary host read failure"));
    await h.runtime.poll();
    expect(h.ledger().waits[0]).toMatchObject({ status: "open" });
    expect(h.ledger().waits[0]?.finishedAt).toBeUndefined();
    expect(h.requestWakeup).not.toHaveBeenCalled();
    await h.runtime.poll();
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
    expect(h.ledger().waits[0]?.status).toBe("woken");
  });

  it.each(["project", "repository", "workspace"] as const)("retires a confirmed %s change while CI is still pending", async (change) => {
    const h = setup();
    await h.runtime.register(registration, run);
    if (change === "project") h.issue.projectId = OTHER;
    if (change === "repository") h.workspace.repoUrl = "https://github.com/acme/other";
    if (change === "workspace") { h.issue.executionWorkspaceId = OTHER; h.workspace.id = OTHER; }
    await h.runtime.poll();
    expect(h.ledger().waits[0]).toMatchObject({ status: "retired", reason: "binding_changed" });
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });

  it.each(["issue", "workspace"] as const)("keeps ambiguous %s reads retryable while CI is pending", async (target) => {
    const h = setup();
    await h.runtime.register(registration, run);
    if (target === "issue") h.issueGet.mockResolvedValueOnce(null as never);
    else h.workspaceGet.mockResolvedValueOnce(null as never);
    await h.runtime.poll();
    expect(h.ledger().waits[0]).toMatchObject({ status: "open" });
    expect(h.ledger().audits.at(-1)?.outcome).toBe("retryable");
    expect(h.requestWakeup).not.toHaveBeenCalled();
    await h.runtime.poll();
    expect(h.ledger().waits[0]?.status).toBe("open");
  });

  it("rechecks binding after terminal readiness even when the initial binding matched", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    github.readiness.mockImplementation(() => { h.issue.executionWorkspaceId = OTHER; h.workspace.id = OTHER; return verdict("pass"); });
    await h.runtime.poll();
    expect(h.ledger().waits[0]).toMatchObject({ status: "retired", reason: "binding_changed" });
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"])("does not wake an ambiguous rerun, then wakes once for corroborated required %s despite same-suite optional work", async (result) => {
    const h = setup();
    await h.runtime.register(registration, run);
    const actual = await vi.importActual<typeof import("../src/ci-github.js")>("../src/ci-github.js");
    github.readiness.mockImplementation(actual.evaluateReadiness);
    const input = {
      repo: REPO, sha: HEAD, baseBranch: "main", fetchedAt: START,
      required: [{ context: "build", appId: 7 }],
      runs: [{ id: 10, name: "build", appId: 7, suiteId: 100, status: "completed", conclusion: result },
        { id: 11, name: "coverage", appId: 7, suiteId: 100, status: "in_progress", conclusion: null }],
      suites: [{ id: 100, appId: 7, status: "in_progress", conclusion: null, createdAt: START, completedAt: null }], statuses: [],
      currentAttemptRunIds: [] as number[],
    };
    github.snapshot.mockResolvedValue(input);
    await h.runtime.poll();
    expect(h.ledger().waits[0]?.status).toBe("open");
    expect(h.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger().audits.filter((entry) => entry.operation === "wake")).toEqual([]);
    input.currentAttemptRunIds = [10];
    await h.runtime.poll();
    await h.runtime.poll();
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
    expect(h.ledger().waits[0]?.status).toBe("woken");
  });

  it("resolves fresh credentials per operation and retains only a credential-scoped token-free cache", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    const originalOptions = github.construct.mock.calls[0]![2] as { cache: unknown };
    h.resolveSecret.mockResolvedValue("rotated-token");
    await h.runtime.poll();
    const secondOptions = github.construct.mock.calls[1]![2] as { cache: unknown };
    expect(h.resolveSecret).toHaveBeenCalledTimes(2);
    expect(github.construct.mock.calls[1]?.[1]).toBe("rotated-token");
    expect(secondOptions.cache).toBe(originalOptions.cache);
    h.rawConfig.githubTokenSecretRef = { ...TOKEN_REF, version: 2 };
    await h.runtime.poll();
    const thirdOptions = github.construct.mock.calls[2]![2] as { cache: unknown };
    expect(thirdOptions.cache).not.toBe(originalOptions.cache);
    expect(JSON.stringify(h.ledger())).not.toContain("rotated-token");
  });

  it("uses a rolling measured repository median, bounds samples, and samples a SHA only once", async () => {
    const h = setup({ repoMedianMs: { [REPO]: 300_000 } });
    await h.runtime.register(registration, run);
    const ledger = h.ledger();
    const key = `${COMPANY}:${REPO}`;
    ledger.samples[key] = Array.from({ length: 31 }, (_, index) => ({ sha: `old-${index}`, ms: 60_000 + index * 1_000 }));
    h.seed(ledger);
    github.snapshot.mockResolvedValue({ suites: [{ createdAt: START - 180_000, completedAt: START }] });
    github.readiness.mockReturnValue(verdict("pass"));
    h.requestWakeup.mockResolvedValue({ queued: false });
    await h.runtime.poll();
    expect(github.readiness).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ medianMs: 75_000 }));
    expect(h.ledger().samples[key]).toHaveLength(31);
    expect(h.ledger().samples[key]?.at(-1)).toEqual({ sha: HEAD, ms: 180_000 });
    await h.runtime.poll();
    expect(h.ledger().samples[key]).toHaveLength(31);
    expect(h.ledger().samples[key]?.filter((sample) => sample.sha === HEAD)).toHaveLength(1);
  });

  it("retires revoked repositories before resolving a fresh GitHub token", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    h.rawConfig.allowedRepos = ["acme/other"];
    h.resolveSecret.mockClear();
    await h.runtime.poll();
    expect(h.resolveSecret).not.toHaveBeenCalled();
    expect(h.ledger().waits[0]).toMatchObject({ status: "retired", reason: "repo_revoked" });
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });

  it("refuses a dry-run toggle made after evaluating checks", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    github.readiness.mockImplementation(() => { h.rawConfig.dryRun = true; return verdict("pass"); });
    await h.runtime.poll();
    expect(h.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger().waits[0]?.status).toBe("open");
  });

  it("retains host queued=false as an open wait and retries with the same idempotency key", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    github.readiness.mockReturnValue(verdict("pass"));
    h.requestWakeup.mockResolvedValueOnce({ queued: false });
    await h.runtime.poll();
    expect(h.ledger().waits[0]?.status).toBe("open");
    expect(h.ledger().waits[0]?.finishedAt).toBeUndefined();
    expect(h.ledger().audits.at(-1)?.outcome).toBe("host_deferred");
    await h.runtime.poll();
    expect(h.requestWakeup).toHaveBeenCalledTimes(2);
    expect(h.requestWakeup.mock.calls[0]).toEqual(h.requestWakeup.mock.calls[1]);
    expect(h.ledger().waits[0]?.status).toBe("woken");
  });

  it.each([
    new Error("Company cannot start work while completed runs await accounting."),
    new Error("Agent cannot start work while completed runs await accounting."),
    new Error("Project cannot start work while completed runs await accounting."),
    new Error("New work must wait while a native run recovers its unfinished accounting."),
    new Error("worker RPC host is not running"),
    Object.assign(new Error("Plugin is held for idle sleep"), { code: -32000 }),
  ])("retries an exact known pre-queue host guard without retiring the wait (%s)", async (error) => {
    const h = setup();
    await h.runtime.register(registration, run);
    github.readiness.mockReturnValue(verdict("pass"));
    h.requestWakeup.mockRejectedValueOnce(error);
    await h.runtime.poll();
    expect(h.ledger().waits[0]?.status).toBe("open");
    expect(h.ledger().waits[0]?.finishedAt).toBeUndefined();
    expect(h.ledger().audits.at(-1)).toMatchObject({ operation: "wake", outcome: "host_deferred" });
    expect(h.logger.warn).not.toHaveBeenCalled();
    const restarted = new CiWakeRuntime(h.ctx, h.clock);
    await restarted.poll();
    await restarted.poll();
    expect(h.requestWakeup).toHaveBeenCalledTimes(2);
    expect(h.requestWakeup.mock.calls[0]).toEqual(h.requestWakeup.mock.calls[1]);
    expect(h.ledger().waits[0]?.status).toBe("woken");
  });

  it.each([
    { label: "accounting text embedded in an unknown error", error: new Error("Wake reply lost: Company cannot start work while completed runs await accounting.") },
    { label: "non-exact SDK shutdown text", error: new Error("Worker RPC host is not running") },
    { label: "idle sleep without the SDK code", error: new Error("Plugin is held for idle sleep") },
    { label: "idle sleep with a different code", error: Object.assign(new Error("Plugin is held for idle sleep"), { code: -32001 }) },
    { label: "an untyped object resembling an accounting error", error: { message: "Company cannot start work while completed runs await accounting." } },
  ])("does not retry ambiguous lookalike host errors: $label", async ({ error }) => {
    const h = setup();
    await h.runtime.register(registration, run);
    github.readiness.mockReturnValue(verdict("pass"));
    h.requestWakeup.mockRejectedValueOnce(error);
    await h.runtime.poll();
    expect(h.ledger().waits[0]?.status).toBe("unconfirmed");
    await new CiWakeRuntime(h.ctx, h.clock).poll();
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
    expect(h.ledger().audits.some((entry) => entry.outcome === "host_deferred")).toBe(false);
  });

  it.each([
    "Company cannot start work while completed runs await accounting.",
    "New work must wait while a native run recovers its unfinished accounting.",
  ])("never classifies an outcome-save failure as a pre-queue host guard after a queued wake (%s)", async (message) => {
    const h = setup();
    await h.runtime.register(registration, run);
    github.readiness.mockReturnValue(verdict("pass"));
    h.failOutcomeWrite(new Error(message));
    await h.runtime.poll();
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
    expect(h.ledger().waits[0]?.status).toBe("woken");
    expect(h.ledger().audits.some((entry) => entry.outcome === "host_deferred")).toBe(false);
    const restarted = new CiWakeRuntime(h.ctx, h.clock);
    expect(await restarted.register(registration, run)).toMatchObject({ data: { status: "woken" } });
    await restarted.poll();
    await h.runtime.poll();
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
  });

  it("treats an ambiguous host exception as unconfirmed and never repeats it across restart or same-run retry", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    github.readiness.mockReturnValue(verdict("fail"));
    h.requestWakeup.mockRejectedValueOnce(new Error(`host may have queued this already ${TOKEN}`));
    await h.runtime.poll();
    expect(h.ledger().waits[0]?.status).toBe("unconfirmed");
    const restarted = new CiWakeRuntime(h.ctx, h.clock);
    await restarted.poll();
    const retry = await restarted.register(registration, run);
    await restarted.poll();
    expect(retry).toMatchObject({ data: { status: "unconfirmed" } });
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).toHaveBeenCalledWith("ci-wake: wake unconfirmed; use the card backstop", expect.any(Object));
    expect(JSON.stringify(h.ledger())).not.toContain(TOKEN);
    expect(JSON.stringify(h.logger.warn.mock.calls)).not.toContain(TOKEN);
  });

  it("settles a persisted in-flight wake as unconfirmed on restart, without calling the host", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    const ledger = h.ledger();
    ledger.waits[0]!.status = "waking";
    h.seed(ledger);
    github.readiness.mockReturnValue(verdict("pass"));
    await new CiWakeRuntime(h.ctx, h.clock).poll();
    expect(h.ledger().waits[0]?.status).toBe("unconfirmed");
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });

  it.each([false, true])("restores an undispatched wait to open after a failed waking save, including a lost write reply (committed=%s)", async (committed) => {
    const h = setup();
    await h.runtime.register(registration, run);
    const waitId = h.ledger().waits[0]!.waitId;
    github.readiness.mockReturnValue(verdict("pass"));
    h.failWakingWrite(committed);
    await h.runtime.poll();
    expect(h.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger().waits[0]).toMatchObject({ waitId, status: "open" });
    expect(h.ledger().waits[0]?.finishedAt).toBeUndefined();
    const restarted = new CiWakeRuntime(h.ctx, h.clock);
    await restarted.poll();
    await restarted.poll();
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
    expect(h.ledger().waits[0]).toMatchObject({ waitId, status: "woken" });
  });

  it("fails closed on a state read outage without credentials or host effects", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    h.resolveSecret.mockClear();
    h.get.mockRejectedValueOnce(new Error("durable state unavailable"));
    await expect(h.runtime.poll()).rejects.toThrow("durable state unavailable");
    expect(h.resolveSecret).not.toHaveBeenCalled();
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });
});

describe("CI wait identity and serialization", () => {
  it("keeps a retry in the same run on the same wait and original deadline", async () => {
    const h = setup();
    const first = await h.runtime.register(registration, run);
    const original = h.ledger().waits[0]!;
    h.advance(60_000);
    const retry = await h.runtime.register(registration, run);
    expect(retry.data).toMatchObject({ waitId: waitData(first).waitId, expiresAt: original.expiresAt, status: "open" });
    expect(h.ledger().waits).toHaveLength(1);
    expect(github.pull).toHaveBeenCalledTimes(1);
    expect(h.resolveSecret).toHaveBeenCalledTimes(1);
  });

  it("joins an active same-head wait from another authorized run rather than duplicating it", async () => {
    const h = setup();
    const first = await h.runtime.register(registration, run);
    h.ownership.runId = NEXT_RUN;
    h.advance(60_000);
    const joined = await h.runtime.register(registration, { ...run, runId: NEXT_RUN });
    expect(joined).toMatchObject({ content: "Joined active CI wait", data: { waitId: waitData(first).waitId, expiresAt: START + LIMITS.waitMs } });
    expect(h.ledger().waits).toHaveLength(1);
  });

  it("creates a new wait for a new authorized run after workspace replacement despite an unchanged branch, repo and head", async () => {
    const h = setup();
    const first = await h.runtime.register(registration, run);
    h.issue.executionWorkspaceId = OTHER;
    h.workspace.id = OTHER;
    h.ownership.runId = NEXT_RUN;
    const replacement = await h.runtime.register(registration, { ...run, runId: NEXT_RUN });
    expect(replacement).toMatchObject({ content: "CI wait registered", data: { status: "open" } });
    expect(waitData(replacement).waitId).not.toBe(waitData(first).waitId);
    expect(h.ledger().waits).toEqual([
      expect.objectContaining({ waitId: waitData(first).waitId, workspaceId: WORKSPACE, status: "retired", reason: "superseded", aliases: [] }),
      expect.objectContaining({ waitId: waitData(replacement).waitId, workspaceId: OTHER, branch: BRANCH, repo: REPO, headSha: HEAD, runId: NEXT_RUN, status: "open" }),
    ]);
    github.readiness.mockReturnValue(verdict("pass"));
    await h.runtime.poll();
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
    expect(h.requestWakeup).toHaveBeenCalledWith(ISSUE, COMPANY, expect.objectContaining({
      idempotencyKey: `ci-wake:${REPO}:${HEAD}:${waitData(replacement).waitId}`,
    }));
  });

  it("refuses a same-run workspace replacement, retaining the retired wait instead of rearming its identity", async () => {
    const h = setup();
    const first = await h.runtime.register(registration, run);
    h.issue.executionWorkspaceId = OTHER;
    h.workspace.id = OTHER;
    h.resolveSecret.mockClear();
    expect(await h.runtime.register(registration, run)).toHaveProperty("error");
    expect(h.ledger().waits).toEqual([
      expect.objectContaining({ waitId: waitData(first).waitId, workspaceId: WORKSPACE, status: "retired", reason: "binding_changed" }),
    ]);
    expect(await h.runtime.register(registration, run)).toMatchObject({ data: { waitId: waitData(first).waitId, status: "retired" } });
    github.readiness.mockReturnValue(verdict("pass"));
    await new CiWakeRuntime(h.ctx, h.clock).poll();
    expect(h.ledger().waits).toHaveLength(1);
    expect(h.resolveSecret).not.toHaveBeenCalled();
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });

  it("remembers a joining run's alias after settlement so its retry cannot rearm the wait", async () => {
    const h = setup();
    const first = await h.runtime.register(registration, run);
    h.ownership.runId = NEXT_RUN;
    await h.runtime.register(registration, { ...run, runId: NEXT_RUN });
    expect(h.ledger().waits[0]?.aliases).toHaveLength(1);
    github.readiness.mockReturnValue(verdict("pass"));
    await h.runtime.poll();
    const restarted = new CiWakeRuntime(h.ctx, h.clock);
    const retry = await restarted.register(registration, { ...run, runId: NEXT_RUN });
    expect(retry).toMatchObject({ data: { waitId: waitData(first).waitId, status: "woken" } });
    await restarted.poll();
    expect(h.ledger().waits).toHaveLength(1);
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
  });

  it("gives a new run a fresh same-SHA wait after CI is rerun, while the settled old wait stays tombstoned", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    github.readiness.mockReturnValue(verdict("fail"));
    await h.runtime.poll();
    const old = h.ledger().waits[0]!;
    h.advance(120_000);
    h.ownership.runId = NEXT_RUN;
    github.readiness.mockReturnValue(verdict("pending"));
    const next = await h.runtime.register(registration, { ...run, runId: NEXT_RUN });
    expect(next).toMatchObject({ data: { status: "open", expiresAt: START + 120_000 + LIMITS.waitMs } });
    expect(waitData(next).waitId).not.toBe(old.waitId);
    await h.runtime.poll();
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
    expect(h.ledger().waits.map((wait) => wait.status)).toEqual(["woken", "open"]);
    expect(github.readiness).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ registeredAt: START + 120_000 }));
    github.readiness.mockReturnValue(verdict("pass"));
    await h.runtime.poll();
    await h.runtime.poll();
    expect(h.requestWakeup).toHaveBeenCalledTimes(2);
    const firstWake = h.requestWakeup.mock.calls[0]![2] as { idempotencyKey: string };
    const nextWake = h.requestWakeup.mock.calls[1]![2] as { idempotencyKey: string };
    expect(nextWake.idempotencyKey).not.toBe(firstWake.idempotencyKey);
  });

  it("supersedes an old open head only after a new explicit head is successfully registered", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    github.pull.mockResolvedValue(pull({ headSha: NEXT_HEAD }));
    await h.runtime.register({ ...registration, headSha: NEXT_HEAD }, run);
    expect(h.ledger().waits).toHaveLength(2);
    expect(h.ledger().waits[0]).toMatchObject({ headSha: HEAD, status: "retired", reason: "superseded" });
    expect(h.ledger().waits[1]).toMatchObject({ headSha: NEXT_HEAD, status: "open" });
  });

  it("serializes concurrent registrations with polling and avoids duplicate effects", async () => {
    const h = setup();
    const entered = deferred();
    const release = deferred();
    github.pull.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return pull(); });
    github.readiness.mockReturnValue(verdict("pass"));
    const first = h.runtime.register(registration, run);
    await entered.promise;
    const poll = h.runtime.poll();
    const retry = h.runtime.register(registration, run);
    const overlappingPoll = h.runtime.poll();
    release.resolve();
    await Promise.all([first, poll, retry, overlappingPoll]);
    expect(h.ledger().waits).toHaveLength(1);
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
    expect(h.ledger().waits[0]?.status).toBe("woken");
  });

  it("follows a targeted poll with a full pass when a scheduled poll arrives in flight, covering the other registered wait", async () => {
    const h = setup();
    const otherWorkspace = { ...h.workspace, id: "66666666-6666-4666-8666-666666666667", branchName: "feature/second-opaque-branch" };
    const otherIssue = { ...h.issue, id: OTHER, executionWorkspaceId: otherWorkspace.id };
    h.issueGet.mockImplementation(async (id) => clone(id === OTHER ? otherIssue : h.issue));
    h.workspaceGet.mockImplementation(async (id) => clone(id === otherWorkspace.id ? otherWorkspace : h.workspace));
    h.assertCheckoutOwner.mockImplementation(async (input) => {
      if (![ISSUE, OTHER].includes(input.issueId) || input.companyId !== COMPANY || input.actorAgentId !== AGENT || input.actorRunId !== RUN) {
        throw new Error("not the checkout owner");
      }
    });
    github.pull.mockImplementation(async (_repo, number) => pull(number === 18
      ? { number: 18, headSha: NEXT_HEAD, headBranch: otherWorkspace.branchName }
      : {}));
    expect(await h.runtime.register(registration, run)).toMatchObject({ data: { status: "open" } });
    expect(await h.runtime.register({ ...registration, issueId: OTHER, prNumber: 18, headSha: NEXT_HEAD }, run)).toMatchObject({ data: { status: "open" } });
    const entered = deferred();
    const release = deferred();
    github.pull.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return pull(); });
    github.readiness.mockReturnValue(verdict("pass"));
    const targeted = h.runtime.poll({ companyId: COMPANY, repo: REPO, sha: HEAD });
    await entered.promise;
    const fullJob = h.runtime.poll();
    await fullJob;
    expect(h.requestWakeup).not.toHaveBeenCalled();
    release.resolve();
    await targeted;
    expect(github.snapshot.mock.calls.map(([, sha]) => sha)).toEqual([HEAD, NEXT_HEAD]);
    expect(h.requestWakeup.mock.calls.map(([issueId]) => issueId)).toEqual([ISSUE, OTHER]);
    expect(h.ledger().waits.map((wait) => wait.status)).toEqual(["woken", "woken"]);
    await h.runtime.poll();
    expect(h.requestWakeup).toHaveBeenCalledTimes(2);
  });

  it("coalesces an overlapping poll while a terminal poll and registration retry are in flight", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    const entered = deferred();
    const release = deferred();
    github.pull.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return pull(); });
    github.readiness.mockReturnValue(verdict("pass"));
    const poll = h.runtime.poll();
    await entered.promise;
    const duplicatePoll = h.runtime.poll();
    const retry = h.runtime.register(registration, run);
    release.resolve();
    await Promise.all([poll, duplicatePoll, retry]);
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
    expect(github.snapshot).toHaveBeenCalledTimes(1);
    expect(h.ledger().waits).toHaveLength(1);
  });
});

describe("signed check_suite hints", () => {
  it("validates the exact raw UTF-8 body using only SHA-256 signatures", () => {
    const body = '{"message":"résumé"}';
    expect(verifyCiSignature(SECRET, body, signature(body))).toBe(true);
    expect(verifyCiSignature(SECRET, `${body}\n`, signature(body))).toBe(false);
    expect(verifyCiSignature("wrong", body, signature(body))).toBe(false);
    expect(verifyCiSignature(SECRET, body, undefined)).toBe(false);
    expect(verifyCiSignature(SECRET, body, `sha1=${createHmac("sha1", SECRET).update(body).digest("hex")}`)).toBe(false);
    expect(verifyCiSignature("", body, signature(body))).toBe(false);
    expect(verifyCiSignature(SECRET, body, "sha256=bad")).toBe(false);
  });

  it("accepts an authenticated hint, ignores parsedBody, and fetches fresh GitHub truth before waking", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    github.readiness.mockReturnValue(verdict("fail"));
    // The signed suite says success, the untrusted parsed object says another SHA,
    // and the authoritative fresh snapshot says failure. Only the last determines readiness.
    await h.runtime.webhook(webhook({ parsedBody: { action: "completed", check_suite: { head_sha: NEXT_HEAD }, repository: { full_name: "evil/repo" } } }));
    expect(h.resolveSecret).toHaveBeenCalledWith(WEBHOOK_REF, { companyId: COMPANY, configPath: "webhookSecretRef" });
    expect(github.snapshot).toHaveBeenCalledWith(REPO, HEAD, "main");
    expect(h.requestWakeup).toHaveBeenCalledWith(ISSUE, COMPANY, expect.objectContaining({ reason: expect.stringContaining("CI fail") }));
    expect(h.ledger().deliveries[`${COMPANY}:${DELIVERY}`]).toBe(START);
  });

  it.each(["disabled", "configuration failure", "secret failure"] as const)("isolates an earlier company's %s from a valid signed hint", async (failure) => {
    const h = setup();
    await h.runtime.register(registration, run);
    const ledger = h.ledger();
    ledger.waits.unshift({ ...ledger.waits[0]!, waitId: "other-company", companyId: OTHER });
    h.seed(ledger);
    h.configGet.mockImplementation(async (companyId) => {
      if (companyId === OTHER && failure === "configuration failure") throw new Error("configuration unavailable");
      return config(companyId === OTHER && failure === "disabled" ? { enabled: false } : {});
    });
    h.resolveSecret.mockImplementation(async (ref, options) => {
      if ((options as { companyId: string }).companyId === OTHER) throw new Error("secret unavailable");
      return ref.secretId === WEBHOOK_REF.secretId ? SECRET : TOKEN;
    });
    github.readiness.mockReturnValue(verdict("pass"));
    await h.runtime.webhook(webhook());
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
    expect(h.requestWakeup).toHaveBeenCalledWith(ISSUE, COMPANY, expect.anything());
    expect(h.ledger().waits.find((wait) => wait.companyId === OTHER)?.status).toBe("open");
    expect(h.ledger().deliveries[`${OTHER}:${DELIVERY}`]).toBeUndefined();
    expect(h.ledger().deliveries[`${COMPANY}:${DELIVERY}`]).toBe(START);
  });

  it("accepts a signed user-owned repository hint without an organization field", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    github.readiness.mockReturnValue(verdict("pass"));
    await h.runtime.webhook(webhook({ payload: { organization: undefined } }));
    expect(h.resolveSecret).toHaveBeenCalledWith(WEBHOOK_REF, { companyId: COMPANY, configPath: "webhookSecretRef" });
    expect(github.snapshot).toHaveBeenCalledWith(REPO, HEAD, "main");
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, 42, "attacker"])("refuses a signed hint with a missing or mismatched repository owner (%j)", async (owner) => {
    const h = setup();
    await h.runtime.register(registration, run);
    h.resolveSecret.mockClear();
    github.pull.mockClear();
    await expect(h.runtime.webhook(webhook({ payload: {
      organization: undefined, repository: { full_name: "Acme/Widget", owner: { login: owner } },
    } }))).rejects.toThrow("webhook_signature_refused");
    expect(github.pull).not.toHaveBeenCalled();
    expect(h.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger().deliveries).toEqual({});
  });

  it("still verifies raw-body HMAC for a user-owned repository", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    github.pull.mockClear();
    await expect(h.runtime.webhook(webhook({ payload: { organization: undefined }, signature: `sha256=${"0".repeat(64)}` }))).rejects.toThrow("webhook_signature_refused");
    expect(github.pull).not.toHaveBeenCalled();
    expect(h.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger().deliveries).toEqual({});
  });

  it.each([
    ["wrong", `sha256=${"0".repeat(64)}`], ["missing", null],
    ["sha1", `sha1=${"0".repeat(40)}`],
  ] as const)("rejects a %s signature without a GitHub request or wake", async (_name, supplied) => {
    const h = setup();
    await h.runtime.register(registration, run);
    github.pull.mockClear();
    await expect(h.runtime.webhook(webhook({ signature: supplied }))).rejects.toThrow();
    expect(github.pull).not.toHaveBeenCalled();
    expect(github.snapshot).not.toHaveBeenCalled();
    expect(h.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger().deliveries).toEqual({});
  });

  it("admits at most six structurally valid bodies per minute and rejects excess before ledger, config or secret reads", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    h.resolveSecret.mockClear();
    const invalid = webhook({ signature: `sha256=${"0".repeat(64)}` });
    for (let index = 0; index < 6; index += 1) {
      await expect(h.runtime.webhook(invalid)).rejects.toThrow("webhook_signature_refused");
    }
    const reads = h.get.mock.calls.length;
    const configReads = h.configGet.mock.calls.length;
    await expect(h.runtime.webhook(invalid)).rejects.toThrow("webhook_admission_budget");
    expect(h.get).toHaveBeenCalledTimes(reads);
    expect(h.configGet).toHaveBeenCalledTimes(configReads);
    expect(h.resolveSecret).toHaveBeenCalledTimes(6);
    expect(h.requestWakeup).not.toHaveBeenCalled();
    h.advance(60_000);
    await expect(h.runtime.webhook(invalid)).rejects.toThrow("webhook_signature_refused");
    expect(h.resolveSecret).toHaveBeenCalledTimes(7);
  });

  it("allows only two outstanding webhooks and rejects overflow before serialization while the runtime lock is occupied", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    const entered = deferred();
    const release = deferred();
    github.pull.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return pull(); });
    const poll = h.runtime.poll();
    await entered.promise;
    h.get.mockClear();
    h.configGet.mockClear();
    h.resolveSecret.mockClear();
    const first = h.runtime.webhook(webhook());
    const second = h.runtime.webhook(webhook({ delivery: NEXT_DELIVERY }));
    try {
      for (let index = 0; index < 3; index += 1) {
        await expect(h.runtime.webhook(webhook())).rejects.toThrow("webhook_admission_budget");
      }
      expect(h.get).not.toHaveBeenCalled();
      expect(h.configGet).not.toHaveBeenCalled();
      expect(h.resolveSecret).not.toHaveBeenCalled();
      expect(h.requestWakeup).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.all([poll, first, second]);
    }
    // Rejected overflow did not consume admissions or strand outstanding slots.
    await h.runtime.webhook(webhook({ delivery: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac" }));
    expect(h.ledger().deliveries[`${COMPANY}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac`]).toBe(START);
  });

  it("does not let a replay trigger a second poll, including while the registration remains open", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    const input = webhook();
    await h.runtime.webhook(input);
    expect(github.snapshot).toHaveBeenCalledTimes(1);
    github.readiness.mockReturnValue(verdict("pass"));
    h.advance(20_000);
    await h.runtime.webhook(input);
    expect(github.snapshot).toHaveBeenCalledTimes(1);
    expect(h.requestWakeup).not.toHaveBeenCalled();
    await h.runtime.webhook(webhook({ delivery: NEXT_DELIVERY }));
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
  });

  it("debounces fresh deliveries for the same active head without trusting their conclusions", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    await h.runtime.webhook(webhook());
    github.readiness.mockReturnValue(verdict("pass"));
    await h.runtime.webhook(webhook({ delivery: NEXT_DELIVERY }));
    expect(github.snapshot).toHaveBeenCalledTimes(1);
    expect(h.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger().deliveries[`${COMPANY}:${NEXT_DELIVERY}`]).toBe(START);
  });

  it("does not discover cards from body links, branch names, pull_requests, or parsedBody without a registration", async () => {
    const h = setup();
    const input = webhook({ payload: {
      check_suite: { head_sha: HEAD, conclusion: "failure", pull_requests: [{ number: 17, head: { ref: "CARD-123" }, body: `Issue: ${ISSUE}` }] },
      body: `https://github.com/acme/widget/pull/17 ${ISSUE}`,
    }, parsedBody: { issueId: ISSUE, repo: REPO, prNumber: 17, headSha: HEAD } });
    github.readiness.mockReturnValue(verdict("fail"));
    await h.runtime.webhook(input);
    expect(h.resolveSecret).not.toHaveBeenCalled();
    expect(github.pull).not.toHaveBeenCalled();
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });

  it("ignores parsedBody that matches a registration when the authenticated raw body does not", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    h.resolveSecret.mockClear();
    github.pull.mockClear();
    await h.runtime.webhook(webhook({ payload: { check_suite: { head_sha: NEXT_HEAD } }, parsedBody: { action: "completed", repository: { full_name: REPO }, check_suite: { head_sha: HEAD } } }));
    expect(h.resolveSecret).not.toHaveBeenCalled();
    expect(github.pull).not.toHaveBeenCalled();
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });

  it.each(["pull_request", "check_run", "push", "ping"])("ignores unsupported %s events even when their body and signature are malformed", async (event) => {
    const h = setup();
    await h.runtime.webhook(webhook({ event, rawBody: "{", signature: null }));
    expect(h.get).not.toHaveBeenCalled();
    expect(h.resolveSecret).not.toHaveBeenCalled();
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });

  it.each([
    { payload: { organization: { login: "attacker" } } },
    { payload: { check_suite: { head_sha: "abbreviated" } } },
    { delivery: "not-a-delivery-uuid" }, { endpointKey: "github" },
    { rawBody: " ".repeat(65_537) },
  ])("fails closed on invalid hint scope, identity, or size (%j)", async (options) => {
    const h = setup();
    await h.runtime.register(registration, run);
    github.pull.mockClear();
    await expect(h.runtime.webhook(webhook(options))).rejects.toThrow();
    expect(github.pull).not.toHaveBeenCalled();
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });

  it("ignores non-completed suites and refuses disabled webhook capability", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    h.resolveSecret.mockClear();
    await h.runtime.webhook(webhook({ payload: { action: "requested" } }));
    expect(h.resolveSecret).not.toHaveBeenCalled();
    h.rawConfig.webhooksEnabled = false;
    await expect(h.runtime.webhook(webhook())).rejects.toThrow("webhook_signature_refused");
    expect(h.resolveSecret).not.toHaveBeenCalled();
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });
});

describe("bounded secret resolution", () => {
  function hangingSecret() {
    let settle!: (value: string) => void;
    const promise = new Promise<string>((resolve) => { settle = resolve; });
    return { promise, settle: (value: string) => settle(value) };
  }

  it("times out a never-settling register secret, releases serialization, and late resolve causes no fetch", async () => {
    const h = setup({}, { secretResolveTimeoutMs: 20 });
    const hanging = hangingSecret();
    const normal = h.resolveSecret.getMockImplementation();
    h.resolveSecret.mockImplementationOnce(() => hanging.promise);
    const result = await h.runtime.register(registration, run);
    expect(result).toHaveProperty("error");
    expect(github.construct).not.toHaveBeenCalled();
    expect(github.pull).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.ledger().waits).toEqual([]);
    // Late settle must not construct a client or fetch.
    hanging.settle(TOKEN);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(github.construct).not.toHaveBeenCalled();
    expect(github.pull).not.toHaveBeenCalled();
    expect(JSON.stringify(h.ledger())).not.toContain(TOKEN);
    // The queue was released: a later registration on the same runtime succeeds.
    h.resolveSecret.mockImplementation(normal as never);
    const retry = await h.runtime.register(registration, run);
    expect(retry).toMatchObject({ data: { status: "open" } });
    expect(h.ledger().waits).toHaveLength(1);
  });

  it("times out a never-settling poll secret, keeps the wait retryable, and late resolve causes no fetch", async () => {
    const h = setup({}, { secretResolveTimeoutMs: 20 });
    await h.runtime.register(registration, run);
    const hanging = hangingSecret();
    const normal = h.resolveSecret.getMockImplementation();
    h.resolveSecret.mockImplementationOnce(() => hanging.promise);
    github.snapshot.mockClear();
    github.pull.mockClear();
    await h.runtime.poll();
    expect(h.ledger().waits[0]).toMatchObject({ status: "open" });
    expect(github.snapshot).not.toHaveBeenCalled();
    expect(h.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger().audits.at(-1)).toMatchObject({ operation: "poll", outcome: "retryable" });
    hanging.settle(TOKEN);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(github.snapshot).not.toHaveBeenCalled();
    expect(h.ledger().waits[0]?.status).toBe("open");
    // Queue released: next poll with a healthy secret proceeds.
    h.resolveSecret.mockImplementation(normal as never);
    github.readiness.mockReturnValue(verdict("pass"));
    await h.runtime.poll();
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
  });

  it("bounds webhook secret resolution the same way and releases serialization", async () => {
    const h = setup({}, { secretResolveTimeoutMs: 20 });
    await h.runtime.register(registration, run);
    const hanging = hangingSecret();
    const normal = h.resolveSecret.getMockImplementation();
    h.resolveSecret.mockImplementation(async (ref: { secretId: string }) => {
      if (ref.secretId === WEBHOOK_REF.secretId) return hanging.promise;
      return normal!(ref, undefined as never) as Promise<string>;
    });
    github.snapshot.mockClear();
    await expect(h.runtime.webhook(webhook())).rejects.toThrow("webhook_signature_refused");
    expect(github.snapshot).not.toHaveBeenCalled();
    expect(h.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger().deliveries).toEqual({});
    hanging.settle(SECRET);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(github.snapshot).not.toHaveBeenCalled();
    // Queue released: a healthy later webhook is admitted and wakes.
    h.resolveSecret.mockImplementation(normal as never);
    github.readiness.mockReturnValue(verdict("pass"));
    await h.runtime.webhook(webhook({ delivery: NEXT_DELIVERY }));
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
  });
});

describe("final-read authorization revalidation", () => {
  // Mutate during the final github.pull (second pull of the poll) and prove
  // no durable wake intent follows. Config changes stay retryable (open);
  // confirmed binding moves retire.
  async function pollWithFinalReadMutation(mutate: (h: ReturnType<typeof setup>) => void) {
    const h = setup();
    await h.runtime.register(registration, run);
    github.readiness.mockReturnValue(verdict("pass"));
    github.pull.mockClear();
    let calls = 0;
    github.pull.mockImplementation(async () => {
      calls += 1;
      if (calls === 2) mutate(h);
      return pull();
    });
    await h.runtime.poll();
    return h;
  }

  it.each([
    ["disabling", (h: ReturnType<typeof setup>) => { h.rawConfig.enabled = false; }],
    ["dry-run enablement", (h: ReturnType<typeof setup>) => { h.rawConfig.dryRun = true; }],
    ["repo revocation", (h: ReturnType<typeof setup>) => { h.rawConfig.allowedRepos = ["acme/other"]; }],
    ["credential change", (h: ReturnType<typeof setup>) => { h.rawConfig.githubTokenSecretRef = { type: "secret_ref", secretId: OTHER }; }],
  ] as const)("prevents dispatch when %s lands during the final PR read", async (_name, mutate) => {
    const h = await pollWithFinalReadMutation(mutate);
    expect(h.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger().waits[0]?.status).toBe("open");
    expect(h.ledger().waits.some((wait) => wait.status === "waking")).toBe(false);
    expect(h.ledger().audits.some((entry) => entry.operation === "wake")).toBe(false);
  });

  it.each([
    ["project rebinding", (h: ReturnType<typeof setup>) => { h.issue.projectId = OTHER; }],
    ["workspace rebinding", (h: ReturnType<typeof setup>) => { h.issue.executionWorkspaceId = OTHER; h.workspace.id = OTHER; }],
    ["repository rebinding", (h: ReturnType<typeof setup>) => { h.workspace.repoUrl = "https://github.com/acme/other"; }],
  ] as const)("retires without dispatch on %s during the final PR read", async (_name, mutate) => {
    const h = await pollWithFinalReadMutation(mutate);
    expect(h.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger().waits[0]).toMatchObject({ status: "retired", reason: "binding_changed" });
    expect(h.ledger().waits.some((wait) => wait.status === "waking")).toBe(false);
  });

  it("does not dispatch when binding evidence goes missing during the final PR read", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    github.readiness.mockReturnValue(verdict("pass"));
    github.pull.mockClear();
    let calls = 0;
    github.pull.mockImplementation(async () => {
      calls += 1;
      if (calls === 2) h.issueGet.mockResolvedValueOnce(null as never);
      return pull();
    });
    await h.runtime.poll();
    expect(h.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger().waits[0]?.status).toBe("open");
    expect(h.ledger().waits.some((wait) => wait.status === "waking")).toBe(false);
  });

  it("still wakes when nothing changes during the final PR read", async () => {
    const h = await pollWithFinalReadMutation(() => undefined);
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
    expect(h.ledger().waits[0]?.status).toBe("woken");
  });
});

describe("CI runtime bounded retention and work quotas", () => {
  it("bounds active waits and refuses overflow before credential access", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    const ledger = h.ledger();
    const original = ledger.waits[0]!;
    ledger.waits = Array.from({ length: LIMITS.active }, (_, index) => ({ ...original, waitId: `active-${index}`, prNumber: 100 + index }));
    h.seed(ledger);
    h.resolveSecret.mockClear();
    expect(await h.runtime.register(registration, run)).toHaveProperty("error");
    expect(h.resolveSecret).not.toHaveBeenCalled();
    expect(h.ledger().waits).toHaveLength(LIMITS.active);
  });

  it("keeps retained tombstones rather than evicting them to accept more waits", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    const ledger = h.ledger();
    const original = ledger.waits[0]!;
    ledger.waits = Array.from({ length: LIMITS.retained }, (_, index) => ({
      ...original, waitId: `retained-${index}`, status: "unconfirmed", finishedAt: START,
    }));
    h.seed(ledger);
    h.resolveSecret.mockClear();
    expect(await h.runtime.register(registration, run)).toHaveProperty("error");
    expect(h.resolveSecret).not.toHaveBeenCalled();
    expect(h.ledger().waits).toHaveLength(LIMITS.retained);
    expect(h.ledger().waits.every((wait) => wait.status === "unconfirmed")).toBe(true);
  });

  it("expires open waits, retains settled tombstones for the full retention interval, then compacts them", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    h.advance(LIMITS.waitMs);
    github.readiness.mockReturnValue(verdict("pass"));
    await h.runtime.poll();
    expect(h.ledger().waits[0]).toMatchObject({ status: "retired", reason: "wait_expired", finishedAt: START + LIMITS.waitMs });
    expect(h.requestWakeup).not.toHaveBeenCalled();
    const retry = await h.runtime.register(registration, run);
    expect(retry).toMatchObject({ data: { status: "retired", expiresAt: START + LIMITS.waitMs } });
    h.advance(LIMITS.retentionMs - 1);
    await h.runtime.poll();
    expect(h.ledger().waits).toHaveLength(1);
    h.advance(1);
    await h.runtime.poll();
    expect(h.ledger().waits).toEqual([]);
  });

  it("advances failed configuration attempts so a healthy company progresses on the next full poll", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    const ledger = h.ledger();
    const original = ledger.waits[0]!;
    ledger.waits = [
      ...Array.from({ length: 6 }, (_, index) => ({ ...original, waitId: `failing-${index}`, companyId: OTHER })),
      { ...original, waitId: "healthy" },
    ];
    h.seed(ledger);
    h.configGet.mockImplementation(async (companyId) => {
      if (companyId === OTHER) { h.advance(30_000); throw new Error("temporary configuration read failure"); }
      return clone(h.rawConfig);
    });
    github.readiness.mockReturnValue(verdict("pass"));
    await h.runtime.poll();
    expect(h.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger().waits.slice(0, 6).every((wait) => wait.lastAttemptAt !== undefined)).toBe(true);
    h.advance(4 * 60_000);
    await h.runtime.poll();
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
    expect(h.ledger().waits.find((wait) => wait.waitId === "healthy")?.status).toBe("woken");
  });

  it("preserves audit evidence while disabled, still recovering, expiring and compacting waits", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    const ledger = h.ledger();
    const original = ledger.waits[0]!;
    ledger.waits = Array.from({ length: LIMITS.active }, (_, index) => ({ ...original, waitId: `active-${index}`, prNumber: 100 + index }));
    ledger.waits.push({ ...original, waitId: "interrupted", status: "waking" });
    ledger.waits.push({ ...original, waitId: "old", status: "woken", finishedAt: START - LIMITS.retentionMs });
    ledger.audits = Array.from({ length: LIMITS.audit }, (_, index) => ({ at: START, operation: "wake", outcome: index % 2 ? "woken" : "unconfirmed" }));
    h.seed(ledger);
    h.rawConfig.enabled = false;
    h.resolveSecret.mockClear();
    github.pull.mockClear();
    h.set.mockClear();
    for (let tick = 0; tick < 3; tick += 1) {
      await h.runtime.poll();
      h.advance(4 * 60_000);
    }
    expect(h.ledger().audits).toEqual(ledger.audits);
    expect(h.ledger().waits.find((wait) => wait.waitId === "interrupted")?.status).toBe("unconfirmed");
    expect(h.ledger().waits.some((wait) => wait.waitId === "old")).toBe(false);
    expect(h.ledger().waits.filter((wait) => wait.status === "open")).toHaveLength(LIMITS.active);
    expect(h.set).toHaveBeenCalledTimes(6);
    expect(h.resolveSecret).not.toHaveBeenCalled();
    expect(github.pull).not.toHaveBeenCalled();
    expect(h.requestWakeup).not.toHaveBeenCalled();
    h.advance(LIMITS.waitMs);
    await h.runtime.poll();
    expect(h.ledger().waits.filter((wait) => wait.status === "open")).toEqual([]);
    expect(h.ledger().audits).toEqual(ledger.audits);
  });

  it("preserves wake evidence under repeated poll intent audits and still saves each intent before credential access", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    const ledger = h.ledger();
    const evidence = { at: START, operation: "wake", outcome: "unconfirmed", waitId: "earlier-wake" };
    ledger.audits = [evidence, ...Array.from({ length: LIMITS.audit - 1 }, () => ({ at: START, operation: "poll", outcome: "intent" }))];
    h.seed(ledger);
    github.readiness.mockReturnValue(verdict("pending"));
    h.resolveSecret.mockImplementation(async () => {
      expect(h.ledger().audits.at(-1)).toMatchObject({ operation: "poll", outcome: "intent", waitId: ledger.waits[0]!.waitId });
      return TOKEN;
    });
    for (let tick = 0; tick < 3; tick += 1) {
      await h.runtime.poll();
      h.advance(4 * 60_000);
    }
    expect(h.ledger().audits).toHaveLength(LIMITS.audit);
    expect(h.ledger().audits).toContainEqual(evidence);
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });

  it("bounds the audit log while preserving the latest refusal", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    const ledger = h.ledger();
    ledger.audits = Array.from({ length: LIMITS.audit }, () => ({ at: START, operation: "old", outcome: "old" }));
    h.seed(ledger);
    await h.runtime.register({ ...registration, extra: true }, run);
    expect(h.ledger().audits).toHaveLength(LIMITS.audit);
    expect(h.ledger().audits.at(-1)).toMatchObject({ operation: "register", outcome: "invalid_registration" });
  });

  it("refuses new webhook deliveries at replay capacity and reclaims only expired replay entries", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    const ledger = h.ledger();
    ledger.deliveries = Object.fromEntries(Array.from({ length: LIMITS.deliveries }, (_, index) => [`old-${index}`, START]));
    h.seed(ledger);
    await expect(h.runtime.webhook(webhook())).rejects.toThrow("replay_capacity");
    expect(github.snapshot).not.toHaveBeenCalled();
    expect(h.requestWakeup).not.toHaveBeenCalled();
    h.advance(LIMITS.replayMs);
    await h.runtime.webhook(webhook());
    expect(Object.keys(h.ledger().deliveries)).toEqual([`${COMPANY}:${DELIVERY}`]);
    expect(github.snapshot).toHaveBeenCalledTimes(1);
  });

  it("limits fresh webhook hints without dropping delivery replay tombstones", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    const ledger = h.ledger();
    ledger.hints = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`another-head-${index}`, START]));
    h.seed(ledger);
    await h.runtime.webhook(webhook());
    expect(github.snapshot).not.toHaveBeenCalled();
    expect(h.ledger().deliveries[`${COMPANY}:${DELIVERY}`]).toBe(START);
    expect(h.ledger().audits.at(-1)).toMatchObject({ operation: "webhook", outcome: "debounced" });
  });

  it("enforces the tick HTTP request budget before making an over-budget host request", async () => {
    const h = setup();
    await h.runtime.register(registration, run);
    github.snapshot.mockImplementation(async () => {
      const fetch = github.construct.mock.lastCall![0] as PluginContext["http"]["fetch"];
      for (let index = 0; index <= LIMITS.requestsPerTick; index += 1) await fetch("https://api.github.com/repos/acme/widget", { method: "GET" });
      return {};
    });
    await h.runtime.poll();
    expect(h.fetch).toHaveBeenCalledTimes(LIMITS.requestsPerTick);
    expect(github.readiness).not.toHaveBeenCalled();
    expect(h.requestWakeup).not.toHaveBeenCalled();
    expect(h.ledger().waits[0]?.status).toBe("open");
  });
});
