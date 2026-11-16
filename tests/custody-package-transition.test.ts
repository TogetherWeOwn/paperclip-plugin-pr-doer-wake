import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import type { CustodyRuntime } from "../src/custody-runtime.js";

const COMPANY = "aaaaaaaa-0000-4000-8000-000000000001";
const AGENT = "cccccccc-0000-4000-8000-000000000001";
const NOW = Date.parse("2026-10-20T12:00:00Z");
const ledgerKey = { scopeKind: "company", scopeId: COMPANY, namespace: "pr-custody-v1", stateKey: "example:live" };
const paths = [process.env.INSTALLED_CUSTODY_RUNTIME, process.env.CANDIDATE_CUSTODY_RUNTIME];
const packageTest = paths.every(Boolean) ? it : it.skip;
const archiveKey = (kind: string, id: string) => JSON.stringify({ ...ledgerKey, stateKey: `${ledgerKey.stateKey}:${kind}:${createHash("sha256").update(id).digest("hex")}` });

type RuntimeClass = new (ctx: PluginContext, now: () => number) => CustodyRuntime;

function fixture() {
  const state = new Map<string, any>();
  const config = { custodyEnabled: true, custodyDryRun: false, custodyCompanyId: COMPANY, custodySummaryAgentId: AGENT, custodyOrg: "example", custodyClosedSince: "2026-10-01T00:00:00Z", githubTokenSecretRef: { type: "secret_ref", secretId: AGENT } };
  let failArchive = false;
  let writeBeforeFailure = false;
  const wake = vi.fn();
  const ctx = {
    config: { get: async () => config },
    state: {
      get: async (key: unknown) => structuredClone(state.get(JSON.stringify(key)) ?? null),
      set: async (key: { stateKey: string }, value: unknown) => {
        if (failArchive && key.stateKey.includes(":receipt:")) {
          if (writeBeforeFailure) state.set(JSON.stringify(key), structuredClone(value));
          throw new Error("synthetic archive write failure");
        }
        state.set(JSON.stringify(key), structuredClone(value));
      },
    },
    db: { query: async () => [] },
    projects: { get: vi.fn(), listWorkspaces: vi.fn() },
    issues: { requestWakeup: wake },
    secrets: { resolve: async () => "synthetic-token" },
    http: { fetch: async () => ({ status: 200, headers: {}, body: "[]" }) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as PluginContext;
  return {
    state, wake,
    runtime: (Runtime: RuntimeClass) => { const runtime = new Runtime(ctx, () => NOW); runtime.setCustodyCompanyId(COMPANY); return runtime; },
    seed: () => {
      const receipts: Record<string, unknown> = { target: { at: NOW - 1000, status: "woken" }, pending: { at: NOW, status: "pending" }, uncertain: { at: NOW, status: "unconfirmed", phase: "wake" } };
      const dispositions: Record<string, number> = { target: NOW - 2000 };
      for (let i = 0; i < 19_870; i++) { receipts[`history-${i}`] = { at: NOW, status: "cleared" }; dispositions[`history-${i}`] = NOW; }
      state.set(JSON.stringify(ledgerKey), { version: 1, cursors: {}, attempted: {}, activityAfter: {}, dispatchSequence: 0, heads: {}, dispositions, receipts, audits: [] });
    },
    ledger: () => state.get(JSON.stringify(ledgerKey)),
    fail: (enabled: boolean, written = false) => { failArchive = enabled; writeBeforeFailure = written; },
  };
}

describe("exact-package custody compaction", () => {
  packageTest.each([[0, 1], [1, 0]] as const)("preserves archived history from package %i to %i", async (from, to) => {
    const Producer = (await import(/* @vite-ignore */ paths[from]!)).CustodyRuntime as RuntimeClass;
    const Consumer = (await import(/* @vite-ignore */ paths[to]!)).CustodyRuntime as RuntimeClass;
    const h = fixture(); h.seed();
    await h.runtime(Producer).poll();
    expect(h.state.get(archiveKey("receipt", "target"))).toEqual({ version: 1, key: "target", value: { at: NOW - 1000, status: "woken" } });
    expect(h.state.get(archiveKey("disposition", "target"))).toEqual({ version: 1, key: "target", value: NOW - 2000 });
    expect(h.ledger().receipts.target).toBeUndefined();
    expect(h.ledger().dispositions.target).toBeUndefined();
    await h.runtime(Consumer).poll();
    expect(h.state.get(archiveKey("receipt", "target"))?.value.status).toBe("woken");
    expect(h.state.get(archiveKey("disposition", "target"))?.value).toBe(NOW - 2000);
    expect(h.ledger().receipts.pending.status).toBe("pending");
    expect(h.ledger().receipts.uncertain.status).toBe("unconfirmed");
    expect(h.wake).not.toHaveBeenCalled();
  });

  packageTest.each([[0, 1, false], [0, 1, true], [1, 0, false], [1, 0, true]] as const)("retains hot tombstone on failed package %i write before package %i recovery (written=%s)", async (from, to, written) => {
    const Producer = (await import(/* @vite-ignore */ paths[from]!)).CustodyRuntime as RuntimeClass;
    const Consumer = (await import(/* @vite-ignore */ paths[to]!)).CustodyRuntime as RuntimeClass;
    const h = fixture(); h.seed(); h.fail(true, written);
    await expect(h.runtime(Producer).poll()).rejects.toThrow("synthetic archive write failure");
    expect(h.ledger().receipts.target.status).toBe("woken");
    expect(h.state.has(archiveKey("receipt", "target"))).toBe(written);
    h.fail(false);
    await h.runtime(Consumer).poll();
    expect(h.ledger().receipts.target).toBeUndefined();
    expect(h.state.get(archiveKey("receipt", "target"))?.value.status).toBe("woken");
    expect(h.wake).not.toHaveBeenCalled();
  });
});
