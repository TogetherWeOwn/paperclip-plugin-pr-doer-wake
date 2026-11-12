import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { CUSTODY_READ_LIMITS, createCustodyByteBudget, loadCustodyCards } from "../src/custody-reader-staged.js";
// Read company metadata and candidate comments under one observation budget.
async function loadAll(ctx: PluginContext, guard: () => void) {
  return loadCustodyCards(ctx, COMPANY, guard);
}

type Row = Record<string, unknown>;
const uuid = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`;
const COMPANY = uuid(90_000);
const OTHER = uuid(90_001);
const AGENT = uuid(90_002);
const AT = "2026-11-10T01:00:00.000Z";
const MS = Date.parse(AT);
const OWN = "plugin:togetherweown.pr-doer-wake:pr-custody";
function card(n = 1, patch: Row = {}): Row {
  return {
    id: uuid(n), company_id: COMPANY, project_id: uuid(90_003), identifier: `TASK-${n}`,
    title: "Fix https://github.com/acme/widgets/pull/7", description: "Implementation owner",
    status: "todo", status_version: "7", assignee_agent_id: AGENT, assignee_user_id: null,
    origin_kind: "manual", conversation_agent_id: null, conversation_user_id: null, conversation_state: null,
    updated_at: AT, completed_at: null, cancelled_at: null, ...patch,
  };
}
function comment(n = 1, patch: Row = {}): Row {
  return {
    id: uuid(n), company_id: COMPANY, issue_id: uuid(1), body: "https://github.com/acme/widgets/pull/8",
    author_agent_id: AGENT, author_user_id: null, author_type: "agent", deleted_at: null,
    updated_at: "2026-11-10T02:00:00.000Z", ...patch,
  };
}
function document(n = 1, patch: Row = {}): Row {
  return {
    id: uuid(n), company_id: COMPANY, issue_id: uuid(1), document_id: uuid(100_000 + n),
    key: `plan-${n}`, updated_at: AT, ...patch,
  };
}
function host(data: { cards?: Row[]; comments?: Row[]; documents?: Row[] } = {}) {
  const tables = {
    issues: data.cards ?? [card()], issue_comments: data.comments ?? [], issue_documents: data.documents ?? [],
  };
  const ordered = {
    issues: [...tables.issues].sort((a, b) => (a.id as string).localeCompare(b.id as string)),
    issue_comments: [...tables.issue_comments].sort((a, b) => (a.id as string).localeCompare(b.id as string)),
    issue_documents: [...tables.issue_documents].sort((a, b) => (a.id as string).localeCompare(b.id as string)),
  };
  const guard = vi.fn<() => void>();
  const trace: string[] = [];
  guard.mockImplementation(() => { trace.push("guard"); });
  const query = vi.fn(async (sql: string, params?: unknown[]): Promise<Row[]> => {
    trace.push("query");
    expect(sql.trim()).toMatch(/^SELECT /);
    expect(sql).toContain("WHERE company_id = $1");
    expect(sql).toContain("id > $2::uuid");
    expect(sql).toContain("ORDER BY id ASC LIMIT $3");
    expect(sql).not.toMatch(/\bOFFSET\b|public\.documents\b|\bSELECT \*/i);
    expect(params?.[0]).toBe(COMPANY);
    const table = /FROM public\.(\w+)/.exec(sql)![1] as keyof typeof tables;
    const [company, cursor, limit, selected] = params!;
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(200);
    let issueIds: string[] | undefined;
    if (table !== "issues") {
      expect(sql).toContain("issue_id = ANY($4::uuid[])");
      // Scalar array literal is intentional: stock host binder expands JS arrays.
      expect(typeof selected).toBe("string");
      issueIds = (selected as string).slice(1, -1).split(",");
    }
    // Model the database's ordered keyset access, not a full-table sort per page.
    const rows = ordered[table];
    let low = 0;
    let high = rows.length;
    if (cursor !== null) while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if ((rows[mid]!.id as string) <= (cursor as string)) low = mid + 1;
      else high = mid;
    }
    const result: Row[] = [];
    for (let i = low; i < rows.length && result.length < (limit as number); i++) {
      const row = rows[i]!;
      if (row.company_id === company && (!issueIds || issueIds.includes(row.issue_id as string))) result.push(row);
    }
    return result;
  });
  const get = vi.fn(async (issueId: string, key: string, companyId: string): Promise<Row | null> => {
    trace.push("get");
    expect(companyId).toBe(COMPANY);
    const metadata = tables.issue_documents.find((row) => row.issue_id === issueId && row.key === key && row.company_id === companyId);
    return metadata ? {
      id: metadata.document_id, companyId, issueId, key,
      body: "https://github.com/acme/widgets/pull/9", updatedAt: new Date("2026-11-10T03:00:00Z"),
    } : null;
  });
  const ctx = { db: { query }, issues: { documents: { get } } } as unknown as PluginContext;
  return { ctx, query, get, guard, trace };
}

describe("loadCustodyCards", () => {
  it("scopes every read, ignores documents, and guards every RPC", async () => {
    const h = host({
      cards: [card(), card(2, { company_id: OTHER })],
      comments: [comment(), comment(2, { company_id: OTHER }), comment(3, { issue_id: uuid(2) })],
      documents: [document(), document(2, { company_id: OTHER }), document(3, { issue_id: uuid(2) })],
    });
    const result = await loadAll(h.ctx,  h.guard);
    expect(result).toEqual([{
      id: uuid(1), companyId: COMPANY, projectId: uuid(90_003), identifier: "TASK-1",
      title: "Fix https://github.com/acme/widgets/pull/7", description: "Implementation owner",
      status: "todo", statusVersion: 7, assigneeAgentId: AGENT, assigneeUserId: null,
      updatedAt: MS, completedAt: null, cancelledAt: null,
      texts: [
        { id: "title", body: "Fix https://github.com/acme/widgets/pull/7", at: MS, ownership: true },
        { id: "description", body: "Implementation owner", at: MS, ownership: true },
        { id: `comment:${uuid(1)}`, body: "https://github.com/acme/widgets/pull/8", at: MS + 3_600_000, ownership: true },
      ],
    }]);
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(h.get).not.toHaveBeenCalled();
    expect(h.trace).toEqual(["guard", "query", "guard", "query"]);
  });

});
