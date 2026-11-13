import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { startWorkerRpcHost } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import manifest from "../src/manifest.js";
import { CUSTODY_READ_LIMITS } from "../src/custody-reader.js";

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
type InventoryFixture = { issues: Record<string, unknown>[]; comments: Record<string, unknown>[]; open?: boolean };

async function custodyHost(storedConfig: Record<string, unknown> = custodyConfig, inventory?: InventoryFixture) {
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
          case "db.query": {
            if (!inventory) { reply(id, []); return; }
            const sql = String(params.sql);
            const args = params.params as [string, string | null, number, string?];
            const rows = sql.includes("public.issue_comments") ? inventory.comments
              : sql.includes("public.issues") ? inventory.issues : null;
            if (!rows) { replyError(id, "unexpected custody table"); return; }
            const candidates = args[3]?.slice(1, -1).split(",");
            reply(id, rows.filter((row) => row.company_id === args[0]
              && (args[1] === null || String(row.id) > args[1])
              && (!candidates || candidates.includes(String(row.issue_id)))).slice(0, args[2]));
            return;
          }
          case "projects.get":
            reply(id, { id: PROJECT, companyId: COMPANY });
            return;
          case "projects.listWorkspaces":
            reply(id, []);
            return;
          case "issues.get":
            reply(id, { id: params.issueId, companyId: COMPANY, workProducts: [] });
            return;
          case "secrets.resolve":
            reply(id, TOKEN);
            return;
          case "http.fetch": {
            const url = new URL(String(params.url));
            let body: unknown[] = [];
            if (inventory && url.pathname === "/orgs/example/repos") body = [{ id: 1, full_name: "example/project", archived: false }];
            if (inventory && url.pathname === "/graphql" && inventory.open) {
              const pageInfo = { hasNextPage: false, endCursor: null };
              const init = params.init as { method?: string; body?: string };
              const request = JSON.parse(init.body ?? "") as { query: string; variables: Record<string, unknown> };
              if (init.method !== "POST" || request.variables.owner !== "example" || request.variables.name !== "project"
                || request.variables.number !== 42 || request.variables.cursor !== null) throw new Error("unexpected GraphQL request");
              const oid = "a".repeat(40);
              const suite = { id: "suite", status: "COMPLETED", createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z" };
              const selection = request.query.includes("checkSuites(")
                ? { commits: { totalCount: 1, nodes: [{ commit: { oid, checkSuites: { totalCount: 1, pageInfo, nodes: [suite] } } }] } }
                : request.query.includes("reviews(") ? { reviews: { totalCount: 0, pageInfo, nodes: [] } }
                  : request.query.includes("commits(first:") ? { commits: { totalCount: 1, pageInfo, nodes: [{ commit: { oid, committedDate: "2026-10-02T00:00:00Z" } }] } }
                    : null;
              if (!selection) throw new Error("unexpected GraphQL selection");
              reply(id, { status: 200, headers: {}, body: JSON.stringify({ data: { repository: { nameWithOwner: "example/project", pullRequest: {
                number: 42, state: "OPEN", headRefOid: oid, createdAt: "2026-10-01T00:00:00Z", repository: { nameWithOwner: "example/project" },
                ...selection,
              } } } }) });
              return;
            }
            if (inventory && url.pathname === "/repos/example/project/pulls" && url.searchParams.get("state") === (inventory.open ? "open" : "closed")) body = [{
              number: 42, user: { login: "contributor", type: "User" },
              head: { ref: "feature", sha: "a".repeat(40), repo: { full_name: "example/project" } },
              base: { repo: { full_name: "example/project" } }, title: "Example", body: null, state: inventory.open ? "open" : "closed",
              created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-10T00:00:00Z",
              closed_at: inventory.open ? null : "2026-10-10T00:00:00Z", merged_at: inventory.open ? null : "2026-10-10T00:00:00Z", merged: !inventory.open,
            }];
            reply(id, { status: 200, headers: {}, body: JSON.stringify(body) });
            return;
          }
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
  const ledger = (): { dispositions: Record<string, number>; report: { complete: boolean; rows: unknown[]; unknown: string[]; effects: number; failure?: string } } | undefined => {
    for (const [key, value] of state.entries()) {
      if (key.startsWith("company:") && key.includes("pr-custody-v1")) {
        return value as ReturnType<typeof ledger>;
      }
    }
    return undefined;
  };
  return { send, stop, calls, ledger };
}

const initialize = { manifest, config: {}, apiVersion: 1, instanceInfo: { instanceId: "11111111-1111-4111-8111-111111111111", hostVersion: "0.0.0-fixture" } };
const runJob = { job: { jobKey: "pr-custody", runId: "dddddddd-0000-4000-8000-000000000001", trigger: "schedule", scheduledAt: SCHEDULED_AT } };

const fixtureId = (n: number) => `eeeeeeee-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const PR_URL = "https://github.com/example/project/pull/42";
const DIRECTIVE = "PR disposition: example/project#42 defer; next actor contributor; revisit 2099-01-01";
const issue = (n: number, title: string, description: string | null, projectId: string | null = null) => ({
  id: fixtureId(n), company_id: COMPANY, project_id: projectId, identifier: null, title, description,
  status: "in_progress", status_version: 1, assignee_agent_id: null, assignee_user_id: null,
  origin_kind: "manual", conversation_agent_id: null, conversation_user_id: null, conversation_state: null,
  updated_at: "2026-10-10T00:00:00Z", completed_at: null, cancelled_at: null,
});
const comment = (n: number, body: string) => ({
  id: fixtureId(n), company_id: COMPANY, issue_id: fixtureId(1), body,
  author_agent_id: null, author_user_id: "human", author_type: "user", deleted_at: null,
  updated_at: "2026-10-11T00:00:00Z",
});

describe("scheduled pr-custody job over the real SDK/host contract", () => {
  it.each([false, true])("only a comment defer suppresses an open idle PR (comment present: %s)", async (withComment) => {
    const h = await custodyHost(custodyConfig, {
      open: true, issues: [issue(1, PR_URL, DIRECTIVE)], comments: withComment ? [comment(1, DIRECTIVE)] : [],
    });
    try {
      await h.send("initialize-open", "initialize", initialize);
      await h.send("config-open", "configChanged", { config: custodyConfig, companyId: COMPANY });
      await h.send("job-open", "runJob", runJob);
      const report = h.ledger()?.report;
      expect(report).toMatchObject({ complete: true, unknown: [], rows: [{ pr: "example/project#42", state: "open", cardId: fixtureId(1), mapping: "url" }] });
      expect((report!.rows[0] as { triggers: string[] }).triggers).toEqual(withComment ? [] : [expect.stringMatching(/^example\/project#42\|idle\|/)]);
    } finally { h.stop(); }
  });

  it.each([false, true])("records disposition clocks from comments only (comment present: %s)", async (withComment) => {
    const h = await custodyHost(custodyConfig, {
      issues: [issue(1, PR_URL, DIRECTIVE)], comments: withComment ? [comment(1, DIRECTIVE)] : [],
    });
    try {
      await h.send("initialize-inventory", "initialize", initialize);
      await h.send("config-inventory", "configChanged", { config: custodyConfig, companyId: COMPANY });
      await h.send("job-inventory", "runJob", runJob);

      expect(h.ledger()?.report).toMatchObject({ complete: true, unknown: [], effects: 0, rows: [
        { pr: "example/project#42", state: "closed", cardId: fixtureId(1), mapping: "url", triggers: [] },
      ] });
      expect(Object.values(h.ledger()!.dispositions)).toEqual(withComment ? [Date.parse("2026-10-11T00:00:00Z")] : []);
      const queries = h.calls.filter((c) => c.method === "db.query");
      expect(queries.some((c) => String(c.params.sql).includes("public.issue_comments"))).toBe(true);
      expect(queries.some((c) => String(c.params.sql).includes("issue_documents"))).toBe(false);
    } finally { h.stop(); }
  });

  it.each([0, 1])("shares the metadata and mapped comment budget at the ceiling + %i byte", async (extra) => {
    // Individually valid bodies, with metadata and comments each below the
    // ceiling but their combined size exactly at it (or one byte over).
    const issues = Array.from({ length: 400 }, (_, i) => issue(i + 1, i === 0 ? PR_URL : "x", "m".repeat(128_000), i === 0 ? null : PROJECT));
    const metadataBytes = 400 * 128_000 + Buffer.byteLength(PR_URL) + 399;
    let remaining = CUSTODY_READ_LIMITS.totalBytes - metadataBytes + extra;
    const comments: Record<string, unknown>[] = [];
    while (remaining > 0) {
      const bytes = Math.min(128_000, remaining);
      comments.push(comment(comments.length + 1, "c".repeat(bytes)));
      remaining -= bytes;
    }
    const h = await custodyHost(custodyConfig, { issues, comments });
    try {
      await h.send("initialize-budget", "initialize", initialize);
      await h.send("config-budget", "configChanged", { config: custodyConfig, companyId: COMPANY });
      const job = h.send("job-budget", "runJob", runJob);
      if (extra) await expect(job).rejects.toThrow("total byte budget exceeded");
      else await job;
      if (extra) {
        expect(h.ledger()?.report).toMatchObject({ complete: false, unknown: ["inventory"], effects: 0, failure: "UNKNOWN custody snapshot: total byte budget exceeded", rows: [] });
      } else {
        expect(h.ledger()?.report).toMatchObject({ complete: true, unknown: [], effects: 0, rows: [
          { pr: "example/project#42", cardId: fixtureId(1), mapping: "url", triggers: [] },
        ] });
      }
      const commentsQuery = h.calls.find((c) => c.method === "db.query" && String(c.params.sql).includes("public.issue_comments"));
      expect((commentsQuery?.params.params as unknown[])[3]).toBe(`{${fixtureId(1)}}`);
      expect(h.calls.some((c) => c.method === "db.query" && String(c.params.sql).includes("issue_documents"))).toBe(false);
    } finally { h.stop(); }
  }, 60_000);
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
