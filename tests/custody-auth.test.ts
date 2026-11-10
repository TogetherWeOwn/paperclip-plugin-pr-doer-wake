import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CustodyAppAuth } from "../src/custody-auth.js";
import { APP_PERMISSIONS } from "../src/ci-auth.js";
import type { CiTokenExchange } from "../src/ci-github.js";

const START = 1_800_000_000_000;
const TOKEN = "ghs_synthetic_custody_installation_token_never_output";
const EXPECTED_PERMISSIONS = { pull_requests: "read", checks: "read", statuses: "read", actions: "read", administration: "read", metadata: "read" };
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function tokenResponse(patch: Record<string, unknown> = {}, entries = 0) {
  return {
    token: TOKEN,
    expires_at: new Date(START + 3_600_000).toISOString(),
    permissions: { ...APP_PERMISSIONS },
    repository_selection: "all",
    ...(entries > 0 ? { repositories: Array.from({ length: entries }, (_, i) => ({ id: i + 1, name: `repo-${i}`, full_name: `acme/repo-${i}` })) } : {}),
    ...patch,
  };
}

function fixture(options: { tokenResponse?: Record<string, unknown>; key?: string; entries?: number } = {}) {
  let now = START;
  const resolve = vi.fn(async () => options.key ?? KEY);
  const auth = new CustodyAppAuth({ appId: "123", installationId: "456", org: "acme", resolvePrivateKey: resolve, now: () => now });
  const exchange = vi.fn(async (_installationId: string, _jwt: string, _body: unknown) => tokenResponse(options.tokenResponse ?? {}, options.entries ?? 0));
  return { auth, resolve, exchange, advance: (ms: number) => { now += ms; } };
}

describe("Custody installation authentication", () => {
  it("mints an installation-wide read-only token without a repository selection", async () => {
    const h = fixture();
    await expect(h.auth.token("/repos/acme/widgets/pulls?state=open", h.exchange as CiTokenExchange)).resolves.toBe(TOKEN);
    expect(h.resolve).toHaveBeenCalledTimes(1);
    expect(h.exchange).toHaveBeenCalledTimes(1);
    const [installationId, jwt, body] = h.exchange.mock.calls[0]!;
    expect(installationId).toBe("456");
    expect(body).toEqual({ permissions: EXPECTED_PERMISSIONS });
    expect(body).not.toHaveProperty("repositories");
    const [headerPart, payloadPart, signaturePart] = String(jwt).split(".");
    expect(JSON.parse(Buffer.from(headerPart!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payloadPart!, "base64url").toString()).iss).toBe("123");
    expect(verify("RSA-SHA256", Buffer.from(`${headerPart}.${payloadPart}`), publicKey, Buffer.from(signaturePart!, "base64url"))).toBe(true);
  });

  it("accepts org, repository and GraphQL paths but refuses anything outside the org before minting", async () => {
    const h = fixture();
    await expect(h.auth.token("/orgs/acme/repos?type=all&per_page=100&page=1", h.exchange as CiTokenExchange)).resolves.toBe(TOKEN);
    await expect(h.auth.token("/graphql", h.exchange as CiTokenExchange)).resolves.toBe(TOKEN);
    for (const path of ["/repos/other-org/widgets/pulls", "/orgs/other-org/repos", "/user", "/repos/acme", "/repos/acmee/widgets/pulls"]) {
      await expect(h.auth.token(path, h.exchange as CiTokenExchange)).rejects.toMatchObject({ code: "input" });
    }
    expect(h.exchange).toHaveBeenCalledTimes(1);
  });

  it("accepts a large same-org repository list and refuses a foreign-org entry", async () => {
    const h = fixture({ entries: 200 });
    await expect(h.auth.token("/repos/acme/widgets/pulls", h.exchange as CiTokenExchange)).resolves.toBe(TOKEN);
    const foreign = fixture({ tokenResponse: { repositories: [{ id: 1, name: "x", full_name: "other-org/x" }] } });
    await expect(foreign.auth.token("/repos/acme/widgets/pulls", foreign.exchange as CiTokenExchange)).rejects.toMatchObject({ code: "auth" });
  });

  it.each([
    ["write permission", { permissions: { ...APP_PERMISSIONS, checks: "write" } }],
    ["extra permission", { permissions: { ...APP_PERMISSIONS, contents: "read" } }],
    ["missing permission", { permissions: { pull_requests: "read" } }],
    ["non-read level", { permissions: { ...APP_PERMISSIONS, metadata: "none" } }],
    ["unknown selection", { repository_selection: "unknown" }],
    ["short token", { token: "short" }],
    ["imminent expiry", { expires_at: new Date(START + 30_000).toISOString() }],
  ])("refuses a token response with %s", async (_label, patch) => {
    const h = fixture({ tokenResponse: patch });
    await expect(h.auth.token("/repos/acme/widgets/pulls", h.exchange as CiTokenExchange)).rejects.toMatchObject({ code: "auth" });
  });

  it("caches the token within the cycle and remints after the expiry margin", async () => {
    let count = 0;
    let now = START;
    const auth = new CustodyAppAuth({ appId: "123", installationId: "456", org: "acme", resolvePrivateKey: async () => KEY, now: () => now });
    // Short GitHub expiry (120s) so the 60s margin remint lands inside the 180s cycle.
    const exchange = vi.fn(async () => ({ ...tokenResponse(), token: `${TOKEN}_${++count}`, expires_at: new Date(now + 120_000).toISOString() }));
    await expect(auth.token("/repos/acme/widgets/pulls", exchange as CiTokenExchange)).resolves.toBe(`${TOKEN}_1`);
    await expect(auth.token("/orgs/acme/repos", exchange as CiTokenExchange)).resolves.toBe(`${TOKEN}_1`);
    expect(exchange).toHaveBeenCalledTimes(1);
    now += 61_000;
    await expect(auth.token("/repos/acme/widgets/pulls", exchange as CiTokenExchange)).resolves.toBe(`${TOKEN}_2`);
    now += 181_000;
    await expect(auth.token("/repos/acme/widgets/pulls", exchange as CiTokenExchange)).rejects.toMatchObject({ code: "timeout" });
  });

  it("refuses invalid keys and sanitizes resolver failures", async () => {
    const bad = fixture({ key: "not a pem" });
    await expect(bad.auth.token("/repos/acme/widgets/pulls", bad.exchange as CiTokenExchange)).rejects.toMatchObject({ code: "auth" });
    expect(bad.exchange).not.toHaveBeenCalled();
    const throwing = new CustodyAppAuth({ appId: "123", installationId: "456", org: "acme", resolvePrivateKey: async () => { throw new Error("secret host down"); } });
    await expect(throwing.token("/repos/acme/widgets/pulls", vi.fn(async () => tokenResponse()) as CiTokenExchange)).rejects.toMatchObject({ code: "auth" });
  });

  it("rejects construction with invalid ids or org and stops after 401 invalidation", async () => {
    for (const options of [
      { appId: "0", installationId: "456", org: "acme" },
      { appId: "123", installationId: "abc", org: "acme" },
      { appId: "123", installationId: "456", org: "Acme" },
      { appId: "123", installationId: "456", org: "bad org" },
    ]) expect(() => new CustodyAppAuth({ ...options, resolvePrivateKey: async () => KEY })).toThrowError("GitHub CI input");
    const h = fixture();
    h.auth.invalidate();
    await expect(h.auth.token("/repos/acme/widgets/pulls", h.exchange as CiTokenExchange)).rejects.toMatchObject({ code: "auth" });
    expect(h.exchange).not.toHaveBeenCalled();
  });
});
