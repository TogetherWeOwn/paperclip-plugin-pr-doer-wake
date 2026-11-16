import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import type { CustodyRuntime } from "../src/custody-runtime.js";

const COMPANY = "aaaaaaaa-0000-4000-8000-000000000001";
const AGENT = "cccccccc-0000-4000-8000-000000000001";
const ISSUE = "bbbbbbbb-0000-4000-8000-000000000001";
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
  let active = false;
  const reads: string[] = [];
  const wake = vi.fn(async () => ({ queued: true, runId: ISSUE }));
  const ctx = {
    config: { get: async () => config },
    state: {
      get: async (key: unknown) => { reads.push(JSON.stringify(key)); return structuredClone(state.get(JSON.stringify(key)) ?? null); },
      set: async (key: { stateKey: string }, value: unknown) => {
        if (failArchive && key.stateKey.includes(":receipt:")) {
          if (writeBeforeFailure) state.set(JSON.stringify(key), structuredClone(value));
          throw new Error("synthetic archive write failure");
        }
        state.set(JSON.stringify(key), structuredClone(value));
      },
    },
    db: { query: async (sql: string) => active && sql.includes("public.issues") ? [{
      id: ISSUE, company_id: COMPANY, project_id: null, identifier: null, title: "https://github.com/example/project/pull/42", description: null,
      status: "in_progress", status_version: 1, assignee_agent_id: AGENT, assignee_user_id: null,
      origin_kind: "manual", conversation_agent_id: null, conversation_user_id: null, conversation_state: null,
      updated_at: "2026-10-10T00:00:00Z", completed_at: null, cancelled_at: null,
    }] : [] },
    projects: { get: vi.fn(), listWorkspaces: vi.fn() },
    issues: { get: async () => ({ id: ISSUE, companyId: COMPANY, workProducts: [] }), requestWakeup: wake },
    secrets: { resolve: async () => "synthetic-token" },
    http: { fetch: async (address: string, init: { body?: string }) => {
      const url = new URL(address);
      let body: unknown = [];
      if (active && url.pathname === "/orgs/example/repos") body = [{ id: 1, full_name: "example/project", archived: false }];
      if (active && url.pathname === "/repos/example/project/pulls" && url.searchParams.get("state") === "open") body = [{
        number: 42, user: { login: "contributor", type: "User" }, head: { ref: "feature", sha: "a".repeat(40), repo: { full_name: "example/project" } },
        base: { repo: { full_name: "example/project" } }, title: "Example", body: null, state: "open", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-10T00:00:00Z", closed_at: null, merged_at: null,
      }];
      if (active && url.pathname === "/graphql") {
        const request = JSON.parse(init.body ?? "") as { query: string };
        const pageInfo = { hasNextPage: false, endCursor: null };
        const oid = "a".repeat(40);
        const suite = { id: "suite", status: "COMPLETED", createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z" };
        const selection = request.query.includes("checkSuites(")
          ? { commits: { totalCount: 1, nodes: [{ commit: { oid, checkSuites: { totalCount: 1, pageInfo, nodes: [suite] } } }] } }
          : request.query.includes("reviews(") ? { reviews: { totalCount: 0, pageInfo, nodes: [] } }
            : { commits: { totalCount: 1, pageInfo, nodes: [{ commit: { oid, committedDate: "2026-10-02T00:00:00Z" } }] } };
        body = { data: { repository: { nameWithOwner: "example/project", pullRequest: { number: 42, state: "OPEN", headRefOid: oid, createdAt: "2026-10-01T00:00:00Z", repository: { nameWithOwner: "example/project" }, ...selection } } } };
      }
      return { status: 200, headers: {}, body: JSON.stringify(body) };
    } },

    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as PluginContext;
  return {
    state, wake, reads,
    activate: () => { active = true; },
    runtime: (Runtime: RuntimeClass) => { const runtime = new Runtime(ctx, () => NOW); runtime.setCustodyCompanyId(COMPANY); return runtime; },
    seed: (target = "target") => {
      const receipts: Record<string, unknown> = { [target]: { at: NOW - 1000, status: "woken" }, pending: { at: NOW, status: "pending" }, uncertain: { at: NOW, status: "unconfirmed", phase: "wake" } };
      const dispositions: Record<string, number> = { target: NOW - 2000 };
      for (let i = 0; i < 19_871; i++) { receipts[`history-${i}`] = { at: NOW, status: "cleared" }; dispositions[`history-${i}`] = NOW; }
      state.set(JSON.stringify(ledgerKey), { version: 1, cursors: {}, attempted: {}, activityAfter: {}, dispatchSequence: 0, heads: {}, dispositions, receipts, audits: [] });
    },
    ledger: () => state.get(JSON.stringify(ledgerKey)),
    fail: (enabled: boolean, written = false) => { failArchive = enabled; writeBeforeFailure = written; },
  };
}

describe("exact-package custody compaction", () => {
  packageTest.each([[0, 1], [1, 0]] as const)("deduplicates an active archived trigger from package %i to %i", async (from, to) => {
    const Producer = (await import(/* @vite-ignore */ paths[from]!)).CustodyRuntime as RuntimeClass;
    const Consumer = (await import(/* @vite-ignore */ paths[to]!)).CustodyRuntime as RuntimeClass;
    const trigger = `example/project#42|idle|${Date.parse("2026-10-02T00:00:00Z")}`;
    const h = fixture(); h.seed(trigger);
    await h.runtime(Producer).poll();
    expect(h.ledger().receipts[trigger]).toBeUndefined();
    expect(h.state.get(archiveKey("receipt", trigger))?.value.status).toBe("woken");
    h.activate(); h.reads.length = 0;
    await h.runtime(Consumer).poll();
    expect(h.ledger().report.rows).toEqual([expect.objectContaining({ pr: "example/project#42", cardId: ISSUE, triggers: [trigger] })]);
    expect(h.reads).toContain(archiveKey("receipt", trigger));
    expect(h.ledger().receipts[trigger]).toBeUndefined();
    expect(h.wake).not.toHaveBeenCalled();
  });

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
