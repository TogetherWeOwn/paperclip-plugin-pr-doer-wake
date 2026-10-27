import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin, { runSweep } from "../src/plugin.js";
import { DB_NAMESPACE } from "../src/constants.js";
import { mayAct } from "../src/github.js";

// Host: createRateLimiter(30, 60_000) per `${companyId}:${pluginId}` in plugin-secrets-handler.ts:195.
const CID = "ef993a7e-5ea7-445f-ba88-27a6a2690c3a";
const SECRET = "whsec-test";
let currentSecret = SECRET;
const repository = { full_name: "TogetherWeOwn/two-web-next", default_branch: "main", owner: { login: "TogetherWeOwn" } };

async function boot() {
  const harness = createTestHarness({
    manifest,
    config: {
      enabled: true, shadow: true, githubOrg: "TogetherWeOwn",
      webhookSecretRef: { type: "secret_ref", secretId: "00000000-0000-4000-8000-000000000001" },
      githubTokenSecretRef: { type: "secret_ref", secretId: "00000000-0000-4000-8000-000000000002" },
    },
  });
  harness.seed({ companies: [{ id: CID, name: "TWO" } as any], issues: [] });
  const ctx = harness.ctx as any;
  const calls = { resolves: 0, fetches: 0 };
  ctx.secrets.resolve = async (ref: { secretId: string }) => {
    calls.resolves += 1;
    if (calls.resolves > 30) throw Object.assign(new Error("Rate limit exceeded for secret resolution"), { name: "RateLimitExceededError" });
    return ref.secretId.endsWith("1") ? currentSecret : "gh-token";
  };
  ctx.db.namespace = DB_NAMESPACE;
  ctx.db.execute = async () => ({ rowCount: 0 });
  ctx.db.query = async () => [];
  ctx.http.fetch = async () => {
    calls.fetches += 1;
    return new Response(JSON.stringify({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: calls.fetches % 3 !== 0, endCursor: "c" }, nodes: [] } } } }), { status: 200 });
  };
  await plugin.definition.setup(harness.ctx);
  return { calls };
}

async function deliver(event: string, payload: Record<string, unknown>, secret = SECRET, signature?: string | null) {
  const body = JSON.stringify({ organization: { login: "TogetherWeOwn" }, repository, ...payload });
  const sig = signature === undefined ? `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` : signature;
  await plugin.definition.onWebhook!({
    endpointKey: "github",
    headers: { "x-github-event": event, ...(sig === null ? {} : { "x-hub-signature-256": sig }) },
    rawBody: body, parsedBody: JSON.parse(body), requestId: crypto.randomUUID(),
  });
}

afterEach(() => {
  vi.useRealTimers();
  currentSecret = SECRET;
});

const run = (action: string, conclusion: string | null) => ({ action, check_run: { name: "build", conclusion, head_sha: "a".repeat(40), pull_requests: [] } });

describe("secret-resolution budget (host limit 30/min)", () => {
  it("a burst of 200 non-actionable org deliveries resolves no secret and never fails", async () => {
    const { calls } = await boot();
    for (let i = 0; i < 50; i += 1) {
      await deliver("check_run", run("created", null));
      await deliver("check_run", run("completed", "success"));
      await deliver("pull_request", { action: "labeled", pull_request: { number: 1 } });
      await deliver("push", { ref: "refs/heads/feature-x" });
      await deliver("status", { state: "failure", sha: "a".repeat(40), context: "legacy" });
    }
    expect(calls.resolves).toBe(0);
  });

  it("actionable deliveries verify against a worker-memory copy of the secret (one resolution)", async () => {
    const { calls } = await boot();
    for (let i = 0; i < 40; i += 1) {
      await deliver("check_run", run("completed", "failure"));
      await deliver("push", { ref: "refs/heads/main" });
    }
    expect(calls.resolves).toBe(1);
  });

  it("forged actionable deliveries (public, guessable URL) cost at most one resolution per backoff window", async () => {
    const { calls } = await boot();
    for (let i = 0; i < 100; i += 1) {
      await expect(deliver("check_run", run("completed", "failure"), "forged")).rejects.toThrow(/signature/);
    }
    expect(calls.resolves).toBeLessThanOrEqual(1);
    await deliver("check_run", run("completed", "failure")); // the real sender still verifies
    expect(calls.resolves).toBeLessThanOrEqual(1);
  });

  it("missing or malformed signatures are rejected before any company or secret work", async () => {
    const { calls } = await boot();
    await expect(deliver("check_run", run("completed", "failure"), SECRET, null)).rejects.toThrow(/signature/);
    await expect(deliver("check_run", run("completed", "failure"), SECRET, "sha1=abc")).rejects.toThrow(/signature/);
    await expect(deliver("check_run", run("completed", "failure"), SECRET, "sha256=zz")).rejects.toThrow(/signature/);
    expect(calls.resolves).toBe(0);
  });

  it("a rotated webhook secret is picked up on a verification miss once the backoff elapses", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T05:00:00Z"));
    const { calls } = await boot();
    await deliver("check_run", run("completed", "failure"));
    expect(calls.resolves).toBe(1);
    currentSecret = "whsec-rotated";
    vi.setSystemTime(new Date("2026-10-27T05:00:10Z"));
    await expect(deliver("check_run", run("completed", "failure"), "whsec-rotated")).rejects.toThrow(/signature/);
    expect(calls.resolves).toBe(1); // inside the 60 s backoff: no re-resolution
    vi.setSystemTime(new Date("2026-10-27T05:01:05Z"));
    await deliver("check_run", run("completed", "failure"), "whsec-rotated");
    expect(calls.resolves).toBe(2);
  });

  it("cached secrets expire after the TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T05:00:00Z"));
    const { calls } = await boot();
    await deliver("check_run", run("completed", "failure"));
    vi.setSystemTime(new Date("2026-10-27T05:11:00Z"));
    await deliver("check_run", run("completed", "failure"));
    expect(calls.resolves).toBe(2);
  });

  it("one sweep over many marked repos and pages resolves the token once", async () => {
    const { calls } = await boot();
    for (let i = 0; i < 12; i += 1) await deliver("push", { ref: "refs/heads/main", repository: { ...repository, full_name: `TogetherWeOwn/r${i}` } });
    const before = calls.resolves;
    await runSweep();
    expect(calls.fetches).toBeGreaterThan(12);
    expect(calls.resolves - before).toBe(1);
  });

  it("mayAct classification", () => {
    expect(mayAct("ping", {})).toBe(false);
    expect(mayAct("check_run", run("completed", "timed_out"))).toBe(true);
    expect(mayAct("check_run", run("completed", "action_required"))).toBe(false);
    expect(mayAct("status", { state: "pending" })).toBe(false);
    expect(mayAct("status", { state: "error" })).toBe(false); // status is not subscribed (README "Webhook events")
    expect(mayAct("pull_request", { action: "synchronize" })).toBe(true);
    expect(mayAct("push", { ref: "refs/heads/main", deleted: true, repository })).toBe(false);
  });
});
