import { createHmac, generateKeyPairSync } from "node:crypto";
import { APP_PERMISSIONS } from "../src/ci-auth.js";
const KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const APP_TOKEN = "ghs_synthetic_runtime_app_token";
import type { PluginContext, PluginWebhookInput, ToolRunContext } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { CiWakeRuntime, type Wait } from "../src/ci-runtime.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const NEXT_RUN = "33333333-3333-4333-8333-333333333334";
const ISSUE = "44444444-4444-4444-8444-444444444444";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const WORKSPACE = "66666666-6666-4666-8666-666666666666";
const TOKEN_REF = { type: "secret_ref", secretId: "88888888-8888-4888-8888-888888888888" };
const HOOK_REF = { type: "secret_ref", secretId: "99999999-9999-4999-8999-999999999999" };
const SECRET = "synthetic-ledger-webhook-secret";
const REPO = "acme/widget";
const SHA = "a".repeat(40);
const BRANCH = "feature/opaque";
const registration = { issueId: ISSUE, repo: REPO, prNumber: 17, headSha: SHA };
const run = { companyId: COMPANY, agentId: AGENT, runId: RUN, projectId: PROJECT } as ToolRunContext;
type Ledger = {
  version: 1; waits: Wait[];
  audits: Array<{ operation: string; outcome: string; waitId?: string }>;
  deliveries: Record<string, number>; hints: Record<string, number>;
  samples: Record<string, Array<{ sha: string; ms: number }>>;
};
const clone = <T>(value: T): T => structuredClone(value);

function signedHint(delivery: number): PluginWebhookInput {
  const rawBody = JSON.stringify({
    action: "completed", repository: { full_name: REPO, owner: { login: "acme" } },
    check_suite: { head_sha: SHA, conclusion: "failure", pull_requests: [] },
  });
  return {
    endpointKey: "github-ci", rawBody, parsedBody: {}, requestId: "fixture-request",
    headers: {
      "x-github-event": "check_suite",
      "x-github-delivery": `aaaaaaaa-aaaa-4aaa-8aaa-${String(delivery).padStart(12, "0")}`,
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(rawBody).digest("hex")}`,
    },
  } as PluginWebhookInput;
}

/** Fixture host only: every call dispatches, with no idempotency-key lookup at all.
 * State copies model durable reads/writes, not host/core integration or a CAS.
 * Runtime locks protect ONE worker; these tests do not establish multi-worker safety.
 */
function setup(app = false) {
  let durable: Ledger | null = null;
  let now = 1_800_000_000_000;
  let terminal = false;
  let ownerRun = RUN;
  let stateOffline = false;
  let reply: "queued" | "ambiguous" | "crash-after-dispatch" = "queued";
  const effects: Array<{ issueId: string; companyId: string }> = [];
  const requestWakeup = vi.fn(async (issueId: string, companyId: string, _options: unknown) => {
    // Deliberately ignore _options.idempotencyKey. A repeated call is a repeated effect.
    effects.push({ issueId, companyId });
    expect(durable?.waits.at(-1)?.status).toBe("waking");
    expect(durable?.audits.at(-1)).toMatchObject({ operation: "wake", outcome: "intent" });
    if (reply === "crash-after-dispatch") stateOffline = true;
    if (reply !== "queued") throw new Error("synthetic reply lost after dispatch");
    return { queued: true };
  });
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname;
    if (path === "/app/installations/456/access_tokens") {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({ repositories: ["widget"], permissions: APP_PERMISSIONS });
      return { status: 201, headers: {}, body: JSON.stringify({ token: APP_TOKEN, expires_at: new Date(now + 3_600_000).toISOString(), repositories: [{ full_name: REPO }], permissions: APP_PERMISSIONS }) };
    }
    if (app) expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${APP_TOKEN}`);
    let status = 200;
    let body: unknown;
    if (path.endsWith("/pulls/17")) body = {
      number: 17, state: "open", merged: false, draft: false, mergeable: true,
      head: { sha: SHA, ref: BRANCH, repo: { full_name: REPO } },
      base: { ref: "main", repo: { full_name: REPO } }, user: { login: "fixture" },
    };
    else if (path.includes("/rules/branches/")) body = [];
    else if (path.endsWith("/protection/required_status_checks")) { status = 404; body = {}; }
    else if (path.endsWith("/check-runs")) body = { total_count: 0, check_runs: [] };
    else if (path.endsWith("/check-suites")) body = { total_count: 0, check_suites: [] };
    else if (path.endsWith("/actions/runs")) body = { total_count: 0, workflow_runs: [] };
    else if (path.endsWith("/statuses")) body = terminal ? [{ id: 1, context: "build", state: "success" }] : [];
    else throw new Error(`unexpected synthetic endpoint ${path}`);
    return { status, headers: {}, body: JSON.stringify(body) };
  });
  const auth = app ? { githubAppId: "123", githubInstallationId: "456", githubAppPrivateKeySecretRef: TOKEN_REF } : { githubTokenSecretRef: TOKEN_REF };
  const resolveSecret = vi.fn(async (ref: { secretId: string }) => ref.secretId === HOOK_REF.secretId ? SECRET : app ? KEY : "synthetic-ledger-token");
  const ctx = {
    config: { get: async () => ({ enabled: true, dryRun: false, allowedRepos: [REPO], ...auth, webhooksEnabled: true, webhookSecretRef: HOOK_REF }) },
    state: {
      get: async () => clone(durable),
      set: async (_key: unknown, value: unknown) => {
        if (stateOffline) throw new Error("synthetic durable-state outage");
        durable = clone(value as Ledger);
      },
    },
    issues: {
      get: async () => ({ id: ISSUE, companyId: COMPANY, projectId: PROJECT, executionWorkspaceId: WORKSPACE }),
      assertCheckoutOwner: async (input: { actorRunId: string }) => {
        if (input.actorRunId !== ownerRun) throw new Error("synthetic checkout refused");
      },
      requestWakeup,
    },
    executionWorkspaces: { get: async () => ({ id: WORKSPACE, companyId: COMPANY, projectId: PROJECT, repoUrl: `https://github.com/${REPO}.git`, branchName: BRANCH }) },
    secrets: { resolve: resolveSecret },
    http: { fetch }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as PluginContext;
  return {
    runtime: () => new CiWakeRuntime(ctx, () => now),
    ledger: () => clone(durable!), effects, requestWakeup, fetch, resolveSecret,
    advance: () => { now += 20_000; }, terminal: () => { terminal = true; },
    reply: (value: typeof reply) => { reply = value; },
    recoverState: () => { stateOffline = false; },
    nextRun: () => { ownerRun = NEXT_RUN; },
  };
}

describe("plugin ledger without host idempotency", () => {
  it("uses App auth consistently for registration, scheduled polls and enabled signed-hint rechecks", async () => {
    const h = setup(true);
    const runtime = h.runtime();
    const registered = await runtime.register(registration, run);
    expect(registered).toMatchObject({ data: { status: "open" } });
    await runtime.poll();
    expect(h.effects).toHaveLength(0);
    h.terminal();
    await runtime.webhook(signedHint(1));
    expect(h.effects).toHaveLength(1);
    expect(h.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(3);
    expect(h.resolveSecret).toHaveBeenCalledWith(TOKEN_REF, { companyId: COMPANY, configPath: "githubAppPrivateKeySecretRef" });
    expect(JSON.stringify(h.ledger())).not.toContain(APP_TOKEN);
    expect(JSON.stringify(h.ledger())).not.toContain(KEY);
    await runtime.poll();
    await runtime.register(registration, run);
    await h.runtime().poll();
    expect(h.effects).toHaveLength(1);
  });
  it.each(["queued", "ambiguous"] as const)("suppresses repeated dispatch after a %s reply across same-run retries, polls, signed hints and restart", async (reply) => {
    const h = setup();
    const runtime = h.runtime();
    const first = await runtime.register(registration, run);
    expect(first).toMatchObject({ data: { status: "open" } });
    const firstData = first.data as { waitId: string; status: string; expiresAt: number };
    expect(await runtime.register(registration, run)).toMatchObject({ data: { waitId: firstData.waitId, status: firstData.status, expiresAt: firstData.expiresAt } });
    await runtime.poll();
    await runtime.webhook(signedHint(1));
    expect(h.ledger().deliveries).toHaveProperty(`${COMPANY}:aaaaaaaa-aaaa-4aaa-8aaa-000000000001`);
    expect(h.effects).toHaveLength(0);

    h.terminal();
    h.reply(reply);
    h.advance();
    // A replay cannot dispatch even when authoritative CI has since become terminal.
    await runtime.webhook(signedHint(1));
    expect(h.effects).toHaveLength(0);
    await runtime.webhook(signedHint(2));
    const status = reply === "queued" ? "woken" : "unconfirmed";
    expect(h.ledger().waits[0]?.status).toBe(status);
    expect(h.effects).toEqual([{ issueId: ISSUE, companyId: COMPANY }]);

    await runtime.poll();
    await runtime.webhook(signedHint(2));
    h.advance();
    await runtime.webhook(signedHint(3));
    const restarted = h.runtime();
    expect(await restarted.register(registration, run)).toMatchObject({ data: { status, waitId: h.ledger().waits[0]!.waitId } });
    await restarted.poll();
    await restarted.poll();
    await restarted.webhook(signedHint(4));
    expect(h.ledger().waits).toHaveLength(1);
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
    expect(h.effects).toHaveLength(1);
    expect(h.ledger().audits.filter((a) => a.operation === "wake").map((a) => a.outcome)).toEqual(["intent", status]);
  });

  it("recovers a durable waking intent after dispatch and total outcome-write failure without repeating the effect", async () => {
    const h = setup();
    const runtime = h.runtime();
    await runtime.register(registration, run);
    h.terminal();
    h.reply("crash-after-dispatch");
    await expect(runtime.poll()).rejects.toThrow("synthetic durable-state outage");
    expect(h.effects).toHaveLength(1);
    expect(h.ledger().waits[0]?.status).toBe("waking");
    expect(h.ledger().audits.at(-1)).toMatchObject({ operation: "wake", outcome: "intent" });

    // Discard the old worker rather than resume it: only durable state survives.
    h.recoverState();
    h.reply("queued");
    const restarted = h.runtime();
    expect(await restarted.register(registration, run)).toMatchObject({ data: { status: "unconfirmed" } });
    await restarted.poll();
    await restarted.webhook(signedHint(1));
    expect(h.ledger().waits[0]?.status).toBe("unconfirmed");
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
    expect(h.effects).toHaveLength(1);
  });

  it("allows a new authorized run to explicitly re-register the same terminal head: not per-SHA exactly-once", async () => {
    const h = setup();
    const runtime = h.runtime();
    await runtime.register(registration, run);
    h.terminal();
    await runtime.poll();
    h.nextRun();
    const restarted = h.runtime();
    expect(await restarted.register(registration, { ...run, runId: NEXT_RUN })).toMatchObject({ data: { status: "open" } });
    // No CI rerun is required for this new identity: a still-terminal snapshot suffices.
    await restarted.poll();
    await restarted.poll();
    expect(h.effects).toHaveLength(2);
    expect(h.ledger().waits.map((w) => w.status)).toEqual(["woken", "woken"]);
    expect(new Set(h.ledger().waits.map((w) => w.waitId)).size).toBe(2);
    // Same-run tombstones are also bounded by retention; this is not an eternal guarantee.
    // Independent workers sharing non-CAS state are outside the single-worker contract.
  });
});
