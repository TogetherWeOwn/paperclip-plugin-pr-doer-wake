import { createInterface } from "node:readline";
import { generateKeyPairSync } from "node:crypto";
import { CiAppAuth, APP_PERMISSIONS } from "../src/ci-auth.js";
import { PassThrough } from "node:stream";
import { definePlugin, startWorkerRpcHost, type PluginContext } from "@paperclipai/plugin-sdk";
import { describe, expect, it } from "vitest";
import { CiGithub, CiGithubCache, GITHUB_USER_AGENT } from "../src/ci-github.js";
import manifest from "../src/manifest.js";

const REPO = "acme/widget";
const SHA = "a".repeat(40);
const NEXT_SHA = "b".repeat(40);
const TOKEN = "synthetic-sdk-compatibility-token";
const URL = `https://api.github.com/repos/${REPO}/pulls/17`;
type HttpCall = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } };
type HostResponse = { status: number; headers: Record<string, string>; body: string; statusText?: string };
function pullResponse(sha = SHA): HostResponse {
  return {
    status: 200, headers: { ETag: '"fixture-v1"' },
    body: JSON.stringify({
      number: 17, state: "open", merged: false, draft: false, mergeable: true,
      head: { sha, ref: "feature/opaque", repo: { full_name: REPO } },
      base: { ref: "main", repo: { full_name: REPO } }, user: { login: "fixture" },
    }),
  };
}
const notModified = (): HostResponse => ({ status: 304, headers: {}, body: "" });

/** Real installed worker RPC + SDK Response construction; synthetic host wire replies.
 * No SDK mock, native Response replacement, network, or actual host/core is involved.
 */
async function sdkHttp(respond: (call: HttpCall, index: number) => HostResponse) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines = createInterface({ input: stdout });
  const calls: HttpCall[] = [];
  let context!: PluginContext;
  let initialized!: () => void;
  let initializationFailed!: (error: Error) => void;
  const initialization = new Promise<void>((resolve, reject) => {
    initialized = resolve;
    initializationFailed = reject;
  });
  lines.on("line", (line) => {
    const message = JSON.parse(line) as {
      id?: string | number; method?: string; params?: HttpCall;
      result?: { ok?: boolean }; error?: { message?: string };
    };
    if (message.id === "initialize-fixture") {
      if (message.result?.ok) initialized();
      else initializationFailed(new Error(message.error?.message ?? "SDK initialization failed"));
      return;
    }
    if (message.method !== "http.fetch" || message.id === undefined) return;
    const call = message.params!;
    calls.push(call);
    // Reply on the next microtask, as a real parent would, through the wire parser.
    try {
      const result = respond(call, calls.length);
      queueMicrotask(() => stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`));
    } catch {
      queueMicrotask(() => stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "synthetic host fixture refused request" } })}\n`));
    }
  });
  const host = startWorkerRpcHost({
    plugin: definePlugin({ async setup(ctx) { context = ctx; } }), stdin, stdout, rpcTimeoutMs: 1_000,
  });
  const stop = () => { host.stop(); lines.close(); stdin.destroy(); stdout.destroy(); };
  stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: "initialize-fixture", method: "initialize",
    params: { manifest, config: {}, apiVersion: 1, instanceInfo: { instanceId: "11111111-1111-4111-8111-111111111111", hostVersion: "0.0.0-fixture" } },
  })}\n`);
  try { await initialization; } catch (error) { stop(); throw error; }
  return { fetch: context.http.fetch.bind(context.http), calls, stop };
}

describe("installed SDK HTTP RPC compatibility", () => {
  it("serializes the narrow App exchange body and recovers 304 with the minted token through the real wrapper", async () => {
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const auth = new CiAppAuth({ appId: "123", installationId: "456", repo: REPO, resolvePrivateKey: async () => key });
    const h = await sdkHttp((call, index) => {
      // GitHub 403s UA-less requests: the exchange and every read carry the User-Agent through the real SDK serialization.
      expect(call.init?.headers?.["User-Agent"]).toBe(GITHUB_USER_AGENT);
      if (index === 1) {
        expect(call.url).toBe("https://api.github.com/app/installations/456/access_tokens");
        expect(call.init?.method).toBe("POST");
        expect(JSON.parse(call.init?.body ?? "{}")).toEqual({ repositories: ["widget"], permissions: APP_PERMISSIONS });
        return { status: 201, headers: { etag: '"must-not-cache"' }, body: JSON.stringify({ token: TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: APP_PERMISSIONS, repositories: [{ full_name: REPO }] }) };
      }
      expect(call.init?.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
      return index === 3 ? notModified() : pullResponse();
    });
    try {
      const client = new CiGithub(h.fetch, auth);
      await client.pull(REPO, 17);
      await client.pull(REPO, 17);
      expect(h.calls).toHaveLength(4);
      expect(h.calls.filter((call) => call.init?.method === "POST")).toHaveLength(1);
    } finally { h.stop(); }
  });
  it("reconstructs a real Response for 200 but rejects a serialized empty-string 304 in the stock SDK wrapper", async () => {
    // Both locked 2026.1023.0 and exact-target 2026.1106.0 use
    // new Response(result.body, ...), which rejects a body even when it is "" for 304.
    const h = await sdkHttp((_call, index) => index === 1 ? pullResponse() : notModified());
    try {
      const response = await h.fetch(URL, { method: "GET" });
      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ head: { sha: SHA } });
      await expect(h.fetch(URL, { method: "GET" })).rejects.toBeInstanceOf(TypeError);
      expect(h.calls).toHaveLength(2);
    } finally { h.stop(); }
  });

  it("pays for exactly one unconditional fresh read after the real SDK rejects a conditional 304", async () => {
    const h = await sdkHttp((_call, index) => index === 1 ? pullResponse() : index === 2 ? notModified() : pullResponse(NEXT_SHA));
    try {
      const cache = new CiGithubCache();
      expect((await new CiGithub(h.fetch, TOKEN, { cache }).pull(REPO, 17)).headSha).toBe(SHA);
      // Runtime creates fresh token-bearing clients while sharing a token-free cache.
      expect((await new CiGithub(h.fetch, TOKEN, { cache }).pull(REPO, 17)).headSha).toBe(NEXT_SHA);
      expect(h.calls).toHaveLength(3);
      expect(h.calls.map((call) => call.url)).toEqual([URL, URL, URL]);
      expect(h.calls.map((call) => call.init?.headers?.["If-None-Match"])).toEqual([undefined, '"fixture-v1"', undefined]);
      expect(h.calls.every((call) => call.init?.method === "GET")).toBe(true);
      expect(h.calls.every((call) => call.init?.headers?.Authorization === `Bearer ${TOKEN}`)).toBe(true);
    } finally { h.stop(); }
  });

  it("charges the SDK-rejected 304 against the budget and cannot make an unbudgeted recovery read", async () => {
    const h = await sdkHttp((_call, index) => index === 1 ? pullResponse() : notModified());
    try {
      const cache = new CiGithubCache();
      await new CiGithub(h.fetch, TOKEN, { cache }).pull(REPO, 17);
      await expect(new CiGithub(h.fetch, TOKEN, { cache, maxRequests: 1 }).pull(REPO, 17)).rejects.toMatchObject({ code: "budget" });
      expect(h.calls).toHaveLength(2);
      expect(h.calls[1]?.init?.headers?.["If-None-Match"]).toBe('"fixture-v1"');
    } finally { h.stop(); }
  });

  it.each([304, 503])("fails closed instead of using cached truth when the one unconditional recovery returns %s", async (status) => {
    const h = await sdkHttp((_call, index) => index === 1 ? pullResponse() : index === 2 ? notModified() : { status, headers: {}, body: "" });
    try {
      const cache = new CiGithubCache();
      await new CiGithub(h.fetch, TOKEN, { cache }).pull(REPO, 17);
      await expect(new CiGithub(h.fetch, TOKEN, { cache }).pull(REPO, 17)).rejects.toMatchObject({ code: status === 304 ? "network" : "http" });
      expect(h.calls).toHaveLength(3);
      expect(h.calls[2]?.init?.headers).not.toHaveProperty("If-None-Match");
    } finally { h.stop(); }
  });
});
