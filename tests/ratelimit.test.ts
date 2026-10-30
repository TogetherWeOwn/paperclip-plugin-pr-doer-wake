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

type Gate = { promise: Promise<void>; open: () => void };
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

let resolveError: ((secretId: string) => Error | null) | null = null;

async function boot(opts: { resolveGate?: () => Gate | null; fetchStatus?: number } = {}) {
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
  const calls = { resolves: 0, fetches: 0, tokenResolves: 0 };
  ctx.secrets.resolve = async (ref: { secretId: string }) => {
    calls.resolves += 1;
    if (ref.secretId.endsWith("2")) calls.tokenResolves += 1;
    const g = opts.resolveGate?.();
    if (g) await g.promise; // the host round trip is still in flight
    if (calls.resolves > 30) throw Object.assign(new Error("Rate limit exceeded for secret resolution"), { name: "RateLimitExceededError" });
    const injected = resolveError?.(ref.secretId);
    if (injected) throw injected;
    return ref.secretId.endsWith("1") ? currentSecret : "gh-token";
  };
  ctx.db.namespace = DB_NAMESPACE;
  ctx.db.execute = async () => ({ rowCount: 0 });
  ctx.db.query = async () => [];
  ctx.http.fetch = async () => {
    calls.fetches += 1;
    if (opts.fetchStatus) return new Response("Bad credentials", { status: opts.fetchStatus });
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
  resolveError = null;
});

// What the worker sees for a host refusal: only the message crosses the JSON-RPC bridge (JsonRpcCallError).
const rpcError = (message: string) => Object.assign(new Error(message), { name: "JsonRpcCallError", code: -32603 });

const run = (action: string, conclusion: string | null) => ({ action, check_run: { name: "build", conclusion, head_sha: "a".repeat(40), pull_requests: [] } });
const redOnPr = (n: number) => {
  const head = n.toString(16).padStart(40, "0");
  return { action: "completed", check_run: { name: "build", conclusion: "failure", head_sha: head, pull_requests: [{ number: n, head: { sha: head, ref: "x" } }] } };
};

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

  it("concurrent genuine deliveries at cold start share one in-flight resolution and all verify", async () => {
    let g: Gate | null = gate();
    const first = g;
    const { calls } = await boot({ resolveGate: () => { const out = g; g = null; return out; } });
    const pending = [1, 2, 3].map(() => deliver("check_run", run("completed", "failure")));
    await new Promise((r) => setTimeout(r, 0));
    first.open();
    const settled = await Promise.allSettled(pending);
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    expect(calls.resolves).toBe(1);
  });

  it("after the TTL, concurrent genuine deliveries verify against the expired value while one re-resolution runs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T05:00:00Z"));
    let g: Gate | null = null;
    const { calls } = await boot({ resolveGate: () => g });
    await deliver("check_run", run("completed", "failure"));
    expect(calls.resolves).toBe(1);
    vi.setSystemTime(new Date("2026-10-27T05:11:00Z"));
    g = gate();
    const slow = g;
    const settled = await Promise.allSettled([1, 2, 3].map(() => deliver("check_run", run("completed", "failure"))));
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    expect(calls.resolves).toBe(2); // one background re-resolution, not one per delivery
    slow.open();
  });

  it("a rotated webhook secret replaces the expired value once the TTL re-resolution lands", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T05:00:00Z"));
    const { calls } = await boot();
    await deliver("check_run", run("completed", "failure"));
    currentSecret = "whsec-rotated";
    vi.setSystemTime(new Date("2026-10-27T05:11:00Z"));
    await deliver("check_run", run("completed", "failure")); // old value still proves authenticity; re-resolve scheduled
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.resolves).toBe(2);
    await expect(deliver("check_run", run("completed", "failure"))).rejects.toThrow(/signature/); // old secret now refused
    await deliver("check_run", run("completed", "failure"), "whsec-rotated");
  });

  it("a GitHub token rejected with 401 is not re-resolved on every lookup (negative cache with backoff)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T05:00:00Z"));
    const { calls } = await boot({ fetchStatus: 401 });
    for (let n = 1; n <= 20; n += 1) await deliver("check_run", redOnPr(n));
    await runSweep();
    expect(calls.tokenResolves).toBe(1);
    expect(calls.fetches).toBe(1);
    vi.setSystemTime(new Date("2026-10-27T05:06:00Z")); // after the backoff: one more resolution picks up a fixed token
    await deliver("check_run", redOnPr(21));
    await deliver("check_run", redOnPr(22));
    expect(calls.tokenResolves).toBe(2);
  });

  for (const [label, message] of [
    ["unbound", "Secret is not bound to plugin:x at githubTokenSecretRef"],
    ["deactivated", "Secret is not active"],
    ["rate-limited", "Rate limit exceeded for secret resolution"],
  ] as const) {
    it(`a GitHub token whose resolution fails (${label}) is not re-resolved on every lookup (negative cache)`, async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-27T05:00:00Z"));
      resolveError = null;
      const { calls } = await boot();
      await deliver("check_run", redOnPr(1)); // webhook secret resolved and cached; token resolved once
      resolveError = (secretId) => (secretId.endsWith("2") ? rpcError(message) : null); // only the token fails
      vi.setSystemTime(new Date("2026-10-27T05:11:00Z")); // token past its TTL
      const before = calls.tokenResolves;
      for (let n = 2; n <= 26; n += 1) await deliver("check_run", redOnPr(n)); // 25 lookups
      await runSweep();
      expect(calls.tokenResolves - before).toBe(1);
      vi.setSystemTime(new Date("2026-10-27T05:12:01Z")); // after the backoff: one more resolution
      await deliver("check_run", redOnPr(27));
      await deliver("check_run", redOnPr(28));
      expect(calls.tokenResolves - before).toBe(2);
    });
  }

  it("pushes do not cause GitHub token resolution or a conflict sweep", async () => {
    const { calls } = await boot();
    for (let i = 0; i < 12; i += 1) await deliver("push", { ref: "refs/heads/main", repository: { ...repository, full_name: `TogetherWeOwn/r${i}` } });
    const before = calls.resolves;
    await runSweep();
    expect(calls.fetches).toBe(0);
    expect(calls.resolves - before).toBe(0);
  });

  it("a deactivated webhook secret stops verifying once its re-resolution fails (fails closed)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T05:00:00Z"));
    await boot();
    await deliver("check_run", run("completed", "failure"));
    resolveError = () => rpcError("Secret is not active"); // operator deactivated the leaked secret (secret_inactive)
    vi.setSystemTime(new Date("2026-10-27T05:11:00Z"));
    await deliver("check_run", run("completed", "failure")); // expired value; schedules the re-resolution
    await new Promise((r) => setTimeout(r, 0));
    vi.setSystemTime(new Date("2026-10-27T05:13:00Z"));
    await expect(deliver("check_run", run("completed", "failure"))).rejects.toThrow(/signature/);
    vi.setSystemTime(new Date("2026-10-27T06:00:00Z"));
    await expect(deliver("check_run", run("completed", "failure"))).rejects.toThrow(/signature/);
  });

  it("an unbound or missing secret evicts the cached value too", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T05:00:00Z"));
    await boot();
    await deliver("check_run", run("completed", "failure"));
    resolveError = () => rpcError("Secret is not bound to plugin:x at webhookSecretRef");
    vi.setSystemTime(new Date("2026-10-27T05:11:00Z"));
    await deliver("check_run", run("completed", "failure"));
    await new Promise((r) => setTimeout(r, 0));
    await expect(deliver("check_run", run("completed", "failure"))).rejects.toThrow(/signature/);
  });

  it("a rate-limited re-resolution keeps the expired value, but only up to a hard maximum age", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T05:00:00Z"));
    await boot();
    await deliver("check_run", run("completed", "failure"));
    resolveError = () => rpcError("Rate limit exceeded for secret resolution");
    vi.setSystemTime(new Date("2026-10-27T05:11:00Z"));
    await deliver("check_run", run("completed", "failure"));
    await new Promise((r) => setTimeout(r, 0));
    vi.setSystemTime(new Date("2026-10-27T05:20:00Z"));
    await deliver("check_run", run("completed", "failure")); // still within the hard maximum: accepted
    await new Promise((r) => setTimeout(r, 0));
    vi.setSystemTime(new Date("2026-10-27T05:31:00Z"));
    await expect(deliver("check_run", run("completed", "failure"))).rejects.toThrow(/signature/);
    resolveError = null;
    vi.setSystemTime(new Date("2026-10-27T05:33:00Z"));
    await deliver("check_run", run("completed", "failure")); // the host resolves again: accepted
  });

  it("mayAct classification", () => {
    expect(mayAct("ping", {})).toBe(false);
    expect(mayAct("check_run", run("completed", "timed_out"))).toBe(true);
    expect(mayAct("check_run", run("completed", "action_required"))).toBe(true);
    expect(mayAct("status", { state: "pending" })).toBe(false);
    expect(mayAct("status", { state: "error" })).toBe(false); // status is not subscribed (README "Webhook events")
    expect(mayAct("pull_request", { action: "labeled", pull_request: { state: "open", draft: false } })).toBe(false);
    expect(mayAct("pull_request", { action: "synchronize", pull_request: { state: "open", draft: true } })).toBe(false);
    // Mergeability is decided by the lookup, not the payload (GitHub reports `unknown` while computing it).
    expect(mayAct("pull_request", { action: "synchronize", pull_request: { state: "open", draft: false, mergeable_state: "unknown", mergeable: null } })).toBe(true);
    expect(mayAct("push", { ref: "refs/heads/main", deleted: true, repository })).toBe(false);
  });
});
