import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { startWorkerRpcHost } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import manifest from "../src/manifest.js";

const COMPANY = "aaaaaaaa-0000-4000-8000-000000000002";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";
const live: Record<string, unknown> = { dryRun: false, dependencyWakeEnabled: true, dependencyWakeShadow: false, dependencyWakeCompanyId: COMPANY };

type HostCall = { method: string; params: Record<string, unknown> };

/**
 * Real worker RPC + plugin entrypoint (tests/custody-sdk.test.ts pattern);
 * synthetic host wire replies. config.get without an explicit companyId is
 * refused, as the production host refuses it for company-less scheduled jobs.
 */
async function dependencyHost(storedConfig: Record<string, unknown> = live) {
  vi.resetModules();
  const { default: plugin } = await import("../src/ci-plugin.js");
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines = createInterface({ input: stdout });
  const calls: HostCall[] = [];
  const state = new Map<string, unknown>();
  const keyOf = (p: Record<string, unknown>) => `${p.scopeKind}:${p.scopeId}:${p.namespace}:${p.stateKey}`;
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const reply = (id: string | number, result: unknown) => stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  const replyError = (id: string | number, message: string) =>
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } })}\n`);

  lines.on("line", (line) => {
    const message = JSON.parse(line) as { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
    if (message.id !== undefined && message.method === undefined) {
      const waiter = pending.get(String(message.id));
      if (waiter) {
        pending.delete(String(message.id));
        if (message.error) waiter.reject(new Error(message.error.message ?? "host request failed"));
        else waiter.resolve(message.result ?? null);
      }
      return;
    }
    if (message.method === undefined || message.id === undefined) return;
    const { method, params, id } = message as { method: string; params: Record<string, unknown>; id: string | number };
    calls.push({ method, params });
    queueMicrotask(() => {
      switch (method) {
        case "config.get":
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
        case "issues.list":
          reply(id, []);
          return;
        default:
          replyError(id, `synthetic host fixture refused ${method}`);
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
  const ledger = () => state.get(`company:${COMPANY}:dependency-wake-v1:live`) as { lastTick?: { complete: boolean } } | undefined;
  const configReads = () => calls.filter((c) => c.method === "config.get");
  return { send, stop, calls, ledger, configReads };
}

const initialize = { manifest, config: {}, apiVersion: 1, instanceInfo: { instanceId: "11111111-1111-4111-8111-111111111111", hostVersion: "0.0.0-fixture" } };
const runJob = { job: { jobKey: "dependency-wake", runId: "dddddddd-0000-4000-8000-000000000002", trigger: "schedule", scheduledAt: "2026-11-11T12:15:00Z" } };

describe("scheduled dependency-wake job over the real SDK/host contract", () => {
  it("a scoped capture lets the job read config for that company only", async () => {
    const h = await dependencyHost();
    try {
      await h.send("init", "initialize", initialize);
      await h.send("config", "configChanged", { config: live, companyId: COMPANY });
      await h.send("job", "runJob", runJob);
      expect(h.configReads().length).toBeGreaterThan(0);
      expect(h.configReads().every((c) => c.params.companyId === COMPANY)).toBe(true);
      expect(h.calls.filter((c) => c.method === "issues.list").every((c) => c.params.companyId === COMPANY)).toBe(true);
      expect(h.ledger()?.lastTick?.complete).toBe(true);
    } finally { h.stop(); }
  });

  it("ignores an unscoped delivery and a delivery whose field names another company", async () => {
    for (const [config, companyId] of [[live, null], [{ ...live, dependencyWakeCompanyId: OTHER }, COMPANY]] as const) {
      const h = await dependencyHost(config);
      try {
        await h.send("init", "initialize", initialize);
        await h.send("config", "configChanged", { config, companyId });
        await h.send("job", "runJob", runJob);
        expect(h.configReads()).toHaveLength(0);
        expect(h.ledger()).toBeUndefined();
      } finally { h.stop(); }
    }
  });

  it("another company's later delivery neither retargets nor clears the capture", async () => {
    const h = await dependencyHost();
    try {
      await h.send("init", "initialize", initialize);
      await h.send("config-a", "configChanged", { config: live, companyId: COMPANY });
      // Identical bytes pass the SDK single-tenant guard and reach onConfigChanged.
      await h.send("config-b", "configChanged", { config: live, companyId: OTHER });
      await h.send("job", "runJob", runJob);
      expect(h.configReads().length).toBeGreaterThan(0);
      expect(h.configReads().every((c) => c.params.companyId === COMPANY)).toBe(true);
      expect(h.ledger()?.lastTick?.complete).toBe(true);
    } finally { h.stop(); }
  });

  it("a delivery from the captured company that disables the job clears the capture", async () => {
    const h = await dependencyHost();
    try {
      await h.send("init", "initialize", initialize);
      await h.send("config-on", "configChanged", { config: live, companyId: COMPANY });
      await h.send("config-off", "configChanged", { config: { ...live, dependencyWakeEnabled: false }, companyId: COMPANY });
      await h.send("job", "runJob", runJob);
      expect(h.configReads()).toHaveLength(0);
      expect(h.ledger()).toBeUndefined();
    } finally { h.stop(); }
  });

  it("onValidateConfig rejects enabling without a company id", async () => {
    const h = await dependencyHost();
    try {
      await h.send("init", "initialize", initialize);
      const rejected = await h.send("bad", "validateConfig", { config: { dependencyWakeEnabled: true } }) as { ok: boolean; errors?: string[] };
      expect(rejected.ok).toBe(false);
      expect(rejected.errors).toContain("dependencyWakeCompanyId must be a UUID when dependencyWakeEnabled is true");
      expect(await h.send("good", "validateConfig", { config: live })).toMatchObject({ ok: true });
    } finally { h.stop(); }
  });
});
