import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CiGithub, GATES_CONTEXT, type CiFetch } from "../src/ci-github.js";
import { CiAppAuth, GATES_PERMISSIONS } from "../src/ci-auth.js";

const REPO = "acme/widget";
const SHA = "a".repeat(40);
const START = 1_800_000_000_000;

describe("gates commit-status create", () => {
  it("POSTs exactly one fixed-context, two-field status body to the status endpoint", async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const fetch: CiFetch = async (input, init) => {
      calls.push({ url: new URL(String(input)), init });
      return { status: 201, headers: {}, body: JSON.stringify({ id: 42, context: GATES_CONTEXT, state: "success" }) };
    };
    const github = new CiGithub(fetch, "synthetic-token", { now: () => START });
    const created = await github.createCommitStatus(REPO, SHA, "success", "RM merge success acme/widget#17 @ aaaaaaa");
    expect(created).toEqual({ id: 42, context: GATES_CONTEXT, state: "success" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.href).toBe(`https://api.github.com/repos/${REPO}/commits/${SHA}/statuses`);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.redirect).toBe("error");
    expect(calls[0]!.init?.headers).toMatchObject({ Authorization: "Bearer synthetic-token", "Content-Type": "application/json" });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ state: "success", context: GATES_CONTEXT, description: "RM merge success acme/widget#17 @ aaaaaaa" });
  });

  it("fails closed on a 403 (missing statuses: write) and never retries inline", async () => {
    const fetch = vi.fn(async () => ({ status: 403, headers: {}, body: JSON.stringify({ message: "Resource not accessible by integration" }) }));
    const github = new CiGithub(fetch, "synthetic-token", { now: () => START });
    const error = await github.createCommitStatus(REPO, SHA, "success", "RM merge success").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "http", status: 403 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses malformed inputs and unexpected response shapes before returning", async () => {
    const fetch = vi.fn(async () => ({ status: 201, headers: {}, body: JSON.stringify({ id: 1, context: "other", state: "success" }) }));
    const github = new CiGithub(fetch, "synthetic-token", { now: () => START });
    await expect(github.createCommitStatus(REPO, SHA, "success", "RM merge success")).rejects.toMatchObject({ code: "response" });
    for (const bad of [
      () => github.createCommitStatus("not-a-repo", SHA, "success", "x"),
      () => github.createCommitStatus(REPO, "not-a-sha", "success", "x"),
      // @ts-expect-error deliberate malformed state
      () => github.createCommitStatus(REPO, SHA, "green", "x"),
      () => github.createCommitStatus(REPO, SHA, "success", ""),
      () => github.createCommitStatus(REPO, SHA, "success", "x".repeat(141)),
      () => github.createCommitStatus(REPO, SHA, "success", "control\nchar"),
    ]) await expect(bad()).rejects.toMatchObject({ code: "input" });
  });
});

describe("gates App write token", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  function approver(perms: Record<string, string>) {
    return async () => ({
      token: "ghs_synthetic_write_token_never_output", expires_at: new Date(START + 3_600_000).toISOString(),
      permissions: perms, repositories: [{ full_name: REPO }], repository_selection: "selected",
    });
  }

  it("mints a statuses:write-only token through the shared exchange", async () => {
    const auth = new CiAppAuth({
      appId: "123", installationId: "456", repo: REPO, now: () => START,
      resolvePrivateKey: async () => KEY, permissions: GATES_PERMISSIONS,
    });
    const token = await auth.token(`/repos/${REPO}/commits/${SHA}/statuses`, approver({ statuses: "write" }));
    expect(token).toBe("ghs_synthetic_write_token_never_output");
  });

  it("fails closed as an auth error when the App grants no statuses: write (short granted set)", async () => {
    const auth = new CiAppAuth({
      appId: "123", installationId: "456", repo: REPO, now: () => START,
      resolvePrivateKey: async () => KEY, permissions: GATES_PERMISSIONS,
    });
    const error = await auth.token(`/repos/${REPO}/commits/${SHA}/statuses`, approver({})).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "auth" });
    const readOnly = await new CiAppAuth({
      appId: "123", installationId: "456", repo: REPO, now: () => START,
      resolvePrivateKey: async () => KEY, permissions: GATES_PERMISSIONS,
    }).token(`/repos/${REPO}/commits/${SHA}/statuses`, approver({ statuses: "read", metadata: "read" })).catch((e: unknown) => e);
    expect(readOnly).toMatchObject({ code: "auth" });
  });

  it("refuses a write token minted for a different repository", async () => {
    const auth = new CiAppAuth({
      appId: "123", installationId: "456", repo: REPO, now: () => START,
      resolvePrivateKey: async () => KEY, permissions: GATES_PERMISSIONS,
    });
    const exchange = async () => ({
      token: "ghs_synthetic_write_token_never_output", expires_at: new Date(START + 3_600_000).toISOString(),
      permissions: { statuses: "write" }, repositories: [{ full_name: "acme/other" }], repository_selection: "selected",
    });
    await expect(auth.token(`/repos/${REPO}/commits/${SHA}/statuses`, exchange)).rejects.toMatchObject({ code: "auth" });
  });
});
