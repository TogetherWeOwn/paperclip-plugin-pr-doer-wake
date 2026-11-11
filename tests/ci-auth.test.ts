import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CiAppAuth, APP_PERMISSIONS } from "../src/ci-auth.js";
import { CiGithub, CiGithubCache, GITHUB_USER_AGENT, type CiFetch } from "../src/ci-github.js";
import { validateCiConfig } from "../src/ci-config.js";

const ref = { type: "secret_ref", secretId: "aaaaaaaa-0000-4000-8000-000000000001" };
const app = { githubAppId: "123", githubInstallationId: "456", githubAppPrivateKeySecretRef: ref };
const base = { enabled: true, allowedRepos: ["example/project"] };
const START = 1_800_000_000_000;
const TOKEN = "ghs_synthetic_installation_token_never_output";
const EXPECTED_PERMISSIONS = { pull_requests: "read", checks: "read", statuses: "read", actions: "read", administration: "read", metadata: "read" };
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const pr = { number: 1, head: { sha: "a".repeat(40), ref: "feature", repo: { full_name: "example/project" } }, base: { ref: "main", repo: { full_name: "example/project" } }, user: { login: "example" }, state: "open", draft: false, merged: false, mergeable: null };
const response = (data: unknown, status = 200, headers = {}) => ({ status, headers, body: JSON.stringify(data) });
function fixture(options: { tokenPatch?: Record<string, unknown>; status?: number; headers?: Record<string, string>; key?: string; maxRequests?: number; cache?: CiGithubCache; failRead?: number } = {}) {
  let now = START;
  const resolve = vi.fn(async () => options.key ?? KEY);
  const auth = new CiAppAuth({ appId: "123", installationId: "456", repo: "example/project", resolvePrivateKey: resolve, now: () => now });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch: CiFetch = async (url, init) => {
    calls.push({ url, init });
    if (init?.method === "POST") return response({ token: TOKEN, expires_at: new Date(now + 3_600_000).toISOString(), permissions: { ...APP_PERMISSIONS, metadata: "read" }, repositories: [{ full_name: "example/project" }], ...options.tokenPatch }, options.status ?? 201, options.headers);
    return response(pr, options.failRead ?? 200);
  };
  const github = new CiGithub(fetch, auth, { now: () => now, maxRequests: options.maxRequests, cache: options.cache });
  return { auth, github, calls, resolve, advance: (ms: number) => { now += ms; } };
}

describe("App installation authentication", () => {
  it("does not start an exchange when key resolution completes after the auth deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    try {
      let resolve!: (key: string) => void;
      const auth = new CiAppAuth({ appId: "123", installationId: "456", repo: "example/project", resolvePrivateKey: () => new Promise<string>((done) => { resolve = done; }) });
      const fetch = vi.fn(async () => response({}, 201));
      const client = new CiGithub(fetch, auth, { requestTimeoutMs: 10 });
      const outcome = client.pull("example/project", 1).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(11);
      expect(await outcome).toMatchObject({ code: "timeout" });
      resolve(KEY);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each([false, true])("refuses reflected previous-cycle GitHub credentials, escaped=%s", async (escaped) => {
    const previous = "ghs_previous_valid_installation_fixture_token";
    let body = JSON.stringify({ ...pr, user: { login: previous } });
    if (escaped) body = body.replace(previous, `\\u0067${previous.slice(1)}`);
    const fetch: CiFetch = async () => ({ status: 200, headers: { etag: '"fixture"' }, body });
    const client = new CiGithub(fetch, TOKEN);
    await expect(client.pull("example/project", 1)).rejects.toMatchObject({ code: "response" });
    expect(JSON.stringify(client)).not.toContain(previous);
  });

  it("signs a short RS256 JWT and explicitly narrows one repository and fixed permissions", async () => {
    const h = fixture();
    await h.github.pull("example/project", 1);
    expect(h.resolve).toHaveBeenCalledTimes(1);
    expect(h.calls[0]?.url).toBe("https://api.github.com/app/installations/456/access_tokens");
    expect(h.calls[0]?.init?.redirect).toBe("error");
    expect(JSON.parse(h.calls[0]?.init?.body as string)).toEqual({ repositories: ["project"], permissions: EXPECTED_PERMISSIONS });
    const jwt = (h.calls[0]?.init?.headers as Record<string, string>).Authorization!.slice(7);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({ iss: "123", iat: START / 1000 - 60, exp: START / 1000 + 300 });
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
    expect((h.calls[1]?.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    // GitHub 403s UA-less requests: the exchange and every read carry the User-Agent.
    for (const call of [h.calls[0]!, h.calls[1]!]) {
      expect((call.init?.headers as Record<string, string>)["User-Agent"]).toBe(GITHUB_USER_AGENT);
    }
    for (const value of [TOKEN, KEY, jwt]) {
      expect(JSON.stringify(h.auth)).not.toContain(value);
      expect(JSON.stringify(h.github)).not.toContain(value);
    }
  });

  it("coalesces concurrent exchange, renews near expiry, and never survives the poll-cycle deadline", async () => {
    const h = fixture({ tokenPatch: { expires_at: new Date(START + 90_000).toISOString() } });
    await Promise.all([h.github.pull("example/project", 1), h.github.pull("example/project", 1)]);
    expect(h.calls.filter((c) => c.init?.method === "POST")).toHaveLength(1);
    h.advance(30_000);
    await expect(h.github.pull("example/project", 1)).rejects.toThrow("auth");
    // Fixture returns the original nearly-expired token; it cannot be used after renewal fails.
    expect(h.calls.filter((c) => c.init?.method === "POST")).toHaveLength(2);
    const fresh = fixture();
    await fresh.github.pull("example/project", 1);
    fresh.advance(180_000);
    await expect(fresh.github.pull("example/project", 1)).rejects.toThrow("timeout");
    expect(fresh.calls).toHaveLength(2);
  });

  it("reports cycle expiry so a longer tick can mint a fresh source", () => {
    let now = START;
    const auth = new CiAppAuth({ appId: "123", installationId: "456", repo: "example/project", resolvePrivateKey: async () => KEY, now: () => now });
    expect(auth.expired()).toBe(false);
    now += 179_999;
    expect(auth.expired()).toBe(false);
    now += 1;
    expect(auth.expired()).toBe(true);
  });

  it("uses a renewed token only after validating the new response", async () => {
    let now = START;
    let count = 0;
    const resolve = vi.fn(async () => KEY);
    const auth = new CiAppAuth({ appId: "123", installationId: "456", repo: "example/project", resolvePrivateKey: resolve, now: () => now });
    const exchange = vi.fn(async () => ({ token: `${TOKEN}_${++count}`, expires_at: new Date(now + 90_000).toISOString(), repositories: [{ full_name: "example/project" }], permissions: APP_PERMISSIONS }));
    expect(await auth.token("/repos/example/project/pulls/1", exchange)).toBe(`${TOKEN}_1`);
    now += 30_000;
    expect(await auth.token("/repos/example/project/pulls/1", exchange)).toBe(`${TOKEN}_2`);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it.each([
    { repositories: [] }, { repositories: [{ full_name: "example/other" }] },
    { repositories: [{ full_name: "example/project" }, { full_name: "example/other" }] },
    { repository_selection: "all" }, { permissions: { ...APP_PERMISSIONS, contents: "read" } },
    { permissions: { ...APP_PERMISSIONS, checks: "write" } }, { permissions: { checks: "read" } },
    { expires_at: new Date(START + 60_000).toISOString() }, { expires_at: new Date(START + 3_660_001).toISOString() },
    { expires_at: "yesterday" }, { token: "raw\r\nheader" }, { token: "" },
  ])("refuses a broadened/malformed token envelope without any data reads: %j", async (tokenPatch) => {
    const h = fixture({ tokenPatch });
    await expect(h.github.pull("example/project", 1)).rejects.toThrow("auth");
    expect(h.calls).toHaveLength(1);
    await expect(h.github.pull("example/project", 1)).rejects.toThrow("auth");
    expect(h.calls).toHaveLength(1);
  });

  it.each(Object.keys(EXPECTED_PERMISSIONS))("refuses missing or write-level %s permission", async (name) => {
    for (const missing of [false, true]) {
      const permissions: Record<string, string> = { ...EXPECTED_PERMISSIONS, [name]: "write" };
      if (missing) delete permissions[name];
      const h = fixture({ tokenPatch: { permissions } });
      await expect(h.github.pull("example/project", 1)).rejects.toThrow("auth");
      expect(h.calls).toHaveLength(1);
    }
  });

  it("narrows every renewal and refuses cross-repository reuse of an existing token", async () => {
    let now = START;
    const auth = new CiAppAuth({ appId: "123", installationId: "456", repo: "example/project", resolvePrivateKey: async () => KEY, now: () => now });
    const exchange = vi.fn(async (_id: string, _jwt: string, _scope: unknown) => ({ token: TOKEN, expires_at: new Date(now + 90_000).toISOString(), repositories: [{ full_name: "example/project" }], permissions: EXPECTED_PERMISSIONS }));
    await auth.token("/repos/example/project/pulls/1", exchange);
    await expect(auth.token("/repos/example/other/pulls/1", exchange)).rejects.toThrow("input");
    expect(exchange).toHaveBeenCalledTimes(1);
    now += 30_000;
    await auth.token("/repos/example/project/check-runs", exchange);
    expect(exchange).toHaveBeenCalledTimes(2);
    for (const call of exchange.mock.calls) {
      expect(call[2]).toEqual({ repositories: ["project"], permissions: EXPECTED_PERMISSIONS });
    }
  });

  it.each([301, 302, 401, 403, 404, 422, 429])("never falls back from exchange HTTP %s to a bearer or wider token", async (status) => {
    const h = fixture({ status });
    await expect(h.github.pull("example/project", 1)).rejects.toMatchObject({ status });
    expect(h.calls).toHaveLength(1);
  });

  it("shares exchange/read request budgets and backoff without caching token responses", async () => {
    const limited = fixture({ maxRequests: 1 });
    await expect(limited.github.pull("example/project", 1)).rejects.toThrow("budget");
    expect(limited.calls).toHaveLength(1);
    const cache = new CiGithubCache();
    const denied = fixture({ cache, status: 429, headers: { "retry-after": "120" } });
    await expect(denied.github.pull("example/project", 1)).rejects.toMatchObject({ status: 429 });
    const next = fixture({ cache });
    await expect(next.github.pull("example/project", 1)).rejects.toThrow("backoff");
    expect(next.resolve).not.toHaveBeenCalled();
    const ok = fixture({ headers: { etag: TOKEN } });
    await ok.github.pull("example/project", 1);
    expect(JSON.stringify(ok.github)).not.toContain(TOKEN);
  });

  it("invalidates a revoked token without a retry in the current cycle", async () => {
    const h = fixture({ failRead: 401 });
    await expect(h.github.pull("example/project", 1)).rejects.toMatchObject({ status: 401 });
    await expect(h.github.pull("example/project", 1)).rejects.toThrow("auth");
    expect(h.calls).toHaveLength(2);
  });

  it("sanitizes every concurrent caller when secret resolution fails", async () => {
    const auth = new CiAppAuth({ appId: "123", installationId: "456", repo: "example/project", resolvePrivateKey: async () => { throw new Error(KEY); } });
    const results = await Promise.allSettled([
      auth.token("/repos/example/project/pulls/1", vi.fn()),
      auth.token("/repos/example/project/pulls/1", vi.fn()),
    ]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(String(result.reason)).toContain("auth");
        expect(String(result.reason)).not.toContain(KEY);
      }
    }
  });

  it("refuses other repositories before secret resolution and sanitizes key/host errors", async () => {
    const h = fixture();
    await expect(h.github.pull("example/other", 1)).rejects.toThrow("input");
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(0);
    const bad = fixture({ key: `private detail ${TOKEN}` });
    const error = await bad.github.pull("example/project", 1).catch((e: unknown) => e);
    expect(String(error)).toContain("auth");
    expect(String(error)).not.toContain(TOKEN);
    expect(bad.calls).toHaveLength(0);
    const auth = new CiAppAuth({ appId: "123", installationId: "456", repo: "example/project", resolvePrivateKey: async () => { throw new Error(KEY); } });
    await expect(auth.token("/repos/example/project/pulls/1", vi.fn())).rejects.toThrow("auth");
  });
});

describe("closed authentication selection", () => {
  it("accepts exactly one complete authentication mode", () => {
    expect(validateCiConfig({ ...base, githubTokenSecretRef: ref })).toEqual([]);
    expect(validateCiConfig({ ...base, ...app })).toEqual([]);
  });

  it("refuses ambiguous, incomplete and unknown authentication even when disabled", () => {
    for (const extra of [app, { githubAppId: "123" }, { githubInstallationId: "456" }, { githubAppPrivateKeySecretRef: ref }, { githubAuthMode: "auto" }]) {
      expect(validateCiConfig({ ...base, githubTokenSecretRef: ref, ...extra }).length).toBeGreaterThan(0);
      expect(validateCiConfig({ enabled: false, githubTokenSecretRef: ref, ...extra }).length).toBeGreaterThan(0);
    }
    for (const githubAppId of ["0", "01", "1e3", "123\n", "9007199254740992", 123]) {
      expect(validateCiConfig({ ...base, ...app, githubAppId }).length).toBeGreaterThan(0);
    }
    expect(validateCiConfig({ ...base, ...app, githubAppPrivateKeySecretRef: "raw-key" }).length).toBeGreaterThan(0);
    expect(validateCiConfig({ ...base, ...app, githubInstallationId: "../tokens" }).length).toBeGreaterThan(0);
  });
});
