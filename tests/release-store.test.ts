import { describe, expect, it, vi } from "vitest";
import { ReleaseStore } from "../src/release-store.js";

const company = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const claim = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const identity = { confirmationId: "cccccccc-cccc-cccc-cccc-cccccccccccc", repo: "example/repo", sha: "a".repeat(40), stagingRunId: "123", stagingRunAttempt: 1, expiresAt: "2026-11-15T03:00:00Z" };
const namespace = "plugin_pr_custody_2a97cdbae1";

describe("release lifecycle adapter", () => {
  it("uses one scoped, parameterized conditional statement for create and revoke", async () => {
    const execute = vi.fn().mockResolvedValue({ rowCount: 1 });
    const store = new ReleaseStore({ namespace, execute });
    expect(await store.create(company, identity)).toBe("applied");
    expect(await store.revoke(company, identity)).toBe("applied");
    expect(execute).toHaveBeenCalledTimes(2);
    for (const [sql, params] of execute.mock.calls) {
      expect(sql).toContain(`${namespace}.release_lifecycle`);
      expect(sql).not.toContain(identity.repo);
      expect(sql).not.toContain(";");
      expect(params.slice(0, 7)).toEqual([company, identity.confirmationId, identity.repo, identity.sha, identity.stagingRunId, identity.stagingRunAttempt, identity.expiresAt]);
    }
  });
  it("disables claim and consume before database access regardless of expiry", async () => {
    const execute = vi.fn().mockResolvedValue({ rowCount: 1 });
    const store = new ReleaseStore({ namespace, execute });
    for (const expiresAt of ["2020-01-01T00:00:00Z", "2099-01-01T00:00:00Z"]) {
      const target = { ...identity, expiresAt };
      expect(await store.claim(company, target, claim)).toBe("unknown");
      expect(await store.consume(company, target, claim)).toBe("unknown");
    }
    expect(execute).not.toHaveBeenCalled();
  });
  it("never infers success or failure from missing, zero, malformed or lost counts", async () => {
    for (const response of [{}, { rowCount: 0 }, { rowCount: 2 }, { rowCount: "1" }, null]) {
      const store = new ReleaseStore({ namespace, execute: vi.fn().mockResolvedValue(response) });
      expect(await store.create(company, identity)).toBe("unknown");
      expect(await store.revoke(company, identity)).toBe("unknown");
    }
    const store = new ReleaseStore({ namespace, execute: vi.fn().mockRejectedValue(new Error("lost response")) });
    expect(await store.revoke(company, identity)).toBe("unknown");
  });
  it("rejects invalid or noncanonical inputs before execution", async () => {
    const execute = vi.fn();
    const store = new ReleaseStore({ namespace, execute });
    expect(await store.claim(company, { ...identity, repo: "Example/repo" }, claim)).toBe("rejected");
    expect(await store.claim(company, { ...identity, expiresAt: "2026-02-30T03:00:00Z" }, claim)).toBe("rejected");
    expect(await store.consume(company, identity, "bad")).toBe("rejected");
    expect(await new ReleaseStore({ namespace: "public", execute }).create(company, identity)).toBe("rejected");
    expect(execute).not.toHaveBeenCalled();
  });
});
