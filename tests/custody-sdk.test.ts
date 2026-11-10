import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { startWorkerRpcHost } from "@paperclipai/plugin-sdk";
import { describe, expect, it } from "vitest";
import plugin from "../src/ci-plugin.js";
import manifest from "../src/manifest.js";

const COMPANY = "aaaaaaaa-0000-4000-8000-000000000001";
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
async function custodyHost() {
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
            else reply(id, custodyConfig);
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
});
