import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { startWorkerRpcHost } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import manifest from "../src/manifest.js";

const COMPANY = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000001";
const PROJECT = "cccccccc-0000-4000-8000-000000000001";
const TOKEN = "synthetic-custody-sdk-token";
const SCHEDULED_AT = "2026-10-20T12:17:00Z";

const custodyConfig: Record<string, unknown> = {
  custodyEnabled: true,
  custodyDryRun: true,
  custodyCompanyId: COMPANY,
  custodySummaryAgentId: PROJECT,
  custodyOrg: "example",
  custodyClosedSince: "2026-10-01T00:00:00Z",
  githubTokenSecretRef: { type: "secret_ref", secretId: PROJECT },
};

type HostCall = { method: string; params: Record<string, unknown> };

/**
 * Real installed worker RPC + plugin definition; synthetic host wire replies.
 * The synthetic host mirrors the installed governed-access gate: a config.get
 * without an explicit companyId is refused exactly as the production host's
 * resolveRequiredCompanyId refuses it during scheduled (proactive, company-less)
 * job invocations. No SDK mock, no host/core, and no network are involved.
 */
async function custodyHost(storedConfig: Record<string, unknown> = custodyConfig) {
  // One worker process per plugin: reset the module so each test gets a
  // fresh worker with no captured company carried over from the last test.
  vi.resetModules();
  const { default: plugin } = await import("../src/ci-plugin.js");
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines = createInterface({ input: stdout });
  const calls: HostCall[] = [];
  const state = new Map<string, unknown>();
  const keyOf = (p: Record<string, unknown>) => `${p.scopeKind}:${p.scopeId}:${p.namespace}:${p.stateKey}`;
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const reply = (id: string | number, result: unknown) =>
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  const replyError = (id: string | number, message: string) =>
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } })}\n`);

  lines.on("line", (line) => {
    const message = JSON.parse(line) as {
      id?: string | number; method?: string; params?: Record<string, unknown>;
      result?: unknown; error?: { message?: string };
    };
    if (message.id !== undefined && message.method === undefined) {
      const waiter = pending.get(String(message.id));
      if (waiter) {
        pending.delete(String(message.id));
        if (message.error) waiter.reject(new Error(message.error.message ?? "host request failed"));
        else waiter.resolve(message.result ?? null);
      }
      return;
    }
    if (message.method === undefined || message.id === undefined) return; // notification (e.g. log)
    const { method, params, id } = message as { method: string; params: Record<string, unknown>; id: string | number };
    calls.push({ method, params });
    queueMicrotask(() => {
      try {
        switch (method) {
          case "config.get":
            // Mirror the production gate: proactive job invocations carry no
            // company scope, so a company-less read is refused here.
            if (!params.companyId) replyError(id, "company context is required");
            else reply(id, storedConfig);
            return;
          case "state.get":
            reply(id, state.get(keyOf(params)) ?? null);
            return;
          case "state.set":
            state.set(keyOf(params), params.value);
            reply(id, null);
            return;
          case "db.query":
            reply(id, []);
            return;
          case "secrets.resolve":
            reply(id, TOKEN);
            return;
          case "http.fetch":
            reply(id, { status: 200, headers: {}, body: "[]" });
            return;
          default:
            replyError(id, `synthetic host fixture refused ${method}`);
        }
      } catch {
        replyError(id, "synthetic host fixture refused request");
      }
    });
  });
  const host = startWorkerRpcHost({ plugin, stdin, stdout, rpcTimeoutMs: 10_000 });
  const stop = () => { host.stop(); lines.close(); stdin.destroy(); stdout.destroy(); };
  const send = (id: string, method: string, params: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const ledger = (): { report: { complete: boolean; rows: unknown[] } } | undefined => {
    for (const [key, value] of state.entries()) {
      if (key.startsWith("company:") && key.includes("pr-custody-v1")) {
        return value as { report: { complete: boolean; rows: unknown[] } };
      }
    }
    return undefined;
  };
  return { send, stop, calls, ledger };
}

const initialize = { manifest, config: {}, apiVersion: 1, instanceInfo: { instanceId: "11111111-1111-4111-8111-111111111111", hostVersion: "0.0.0-fixture" } };
const runJob = { job: { jobKey: "pr-custody", runId: "dddddddd-0000-4000-8000-000000000001", trigger: "schedule", scheduledAt: SCHEDULED_AT } };

describe("scheduled pr-custody job over the real SDK/host contract", () => {
  it("completes one inventory tick with every config read explicitly company-scoped", async () => {
    const h = await custodyHost();
    try {
      await h.send("initialize-fixture", "initialize", initialize);
      // The loader replays stored company config here, before any job runs.
      await h.send("config-fixture", "configChanged", { config: custodyConfig, companyId: COMPANY });
      await h.send("job-fixture", "runJob", runJob);

      const configReads = h.calls.filter((c) => c.method === "config.get");
      expect(configReads.length).toBeGreaterThan(0);
      expect(configReads.every((c) => c.params.companyId === COMPANY)).toBe(true);
      expect(h.ledger()?.report.complete).toBe(true);
      expect(h.ledger()?.report.rows).toEqual([]);
    } finally { h.stop(); }
  });

  it("fails closed without ever retrying a company-less config read when no config was delivered", async () => {
    const h = await custodyHost();
    try {
      await h.send("initialize-control", "initialize", initialize);
      await h.send("job-control", "runJob", runJob);

      expect(h.calls.some((c) => c.method === "config.get")).toBe(false);
      expect(h.ledger()).toBeUndefined();
    } finally { h.stop(); }
  });

  it("never reads the other company when a delivery for a company names a different company in its field", async () => {
    const mismatched = { ...custodyConfig, custodyCompanyId: OTHER };
    const h = await custodyHost(mismatched);
    try {
      await h.send("initialize-mismatch", "initialize", initialize);
      // Delivery is scoped to COMPANY but its stored field names OTHER:
      // the capture must not adopt OTHER, and the tick must not read
      // config for the wrong company at all.
      await h.send("config-mismatch", "configChanged", { config: mismatched, companyId: COMPANY });
      await h.send("job-mismatch", "runJob", runJob);

      const configReads = h.calls.filter((c) => c.method === "config.get");
      expect(configReads.some((c) => c.params.companyId === OTHER)).toBe(false);
      expect(configReads).toHaveLength(0);
      expect(h.ledger()).toBeUndefined();
    } finally { h.stop(); }
  });

  it("never reads config when the delivery carries no company scope", async () => {
    const h = await custodyHost();
    try {
      await h.send("initialize-unscoped", "initialize", initialize);
      await h.send("config-unscoped", "configChanged", { config: custodyConfig, companyId: null });
      await h.send("job-unscoped", "runJob", runJob);

      expect(h.calls.some((c) => c.method === "config.get")).toBe(false);
      expect(h.ledger()).toBeUndefined();
    } finally { h.stop(); }
  });

  it("another company's later delivery neither retargets nor disables the captured custody company", async () => {
    const h = await custodyHost();
    try {
      await h.send("initialize-multicompany", "initialize", initialize);
      await h.send("config-a", "configChanged", { config: custodyConfig, companyId: COMPANY });
      // A delivery scoped to a different company must not clear the capture
      // for COMPANY. The stored config bytes are identical, so this reaches
      // onConfigChanged past the SDK single-tenant guard (which rejects a
      // second distinct company's *different* config before the plugin sees
      // it); the plugin's own binding then ignores it because the field
      // names COMPANY, not the delivering company.
      await h.send("config-b", "configChanged", { config: custodyConfig, companyId: OTHER });
      await h.send("job-multicompany", "runJob", runJob);

      const configReads = h.calls.filter((c) => c.method === "config.get");
      expect(configReads.length).toBeGreaterThan(0);
      expect(configReads.every((c) => c.params.companyId === COMPANY)).toBe(true);
      expect(h.ledger()?.report.complete).toBe(true);
    } finally { h.stop(); }
  });
});
