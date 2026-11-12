import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { CUSTODY_READ_LIMITS, loadCustodyCards, loadCustodyTexts, parseWorkProductBindings } from "../src/custody-reader.js";

// Full evidence for a candidate set: metadata for the company, then
// comments for the selected cards only (TWO-5928 scale fix; documents are
// never read, per the TWO-6426 comments-only directive decision).
async function loadAll(ctx: PluginContext, guard: () => void) {
  const cards = await loadCustodyCards(ctx, COMPANY, guard); // helper keeps metadata phase
  return loadCustodyTexts(ctx, COMPANY, guard, cards);
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
  it("scopes every read to the company and guards every RPC", async () => {
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

  it("never reads documents, even an oversized linked body; comment directives still load", async () => {
    const h = host({
      comments: [comment(1, { body: "PR disposition: acme/widgets#8 defer" })],
      documents: [document()],
    });
    h.get.mockResolvedValue({ id: uuid(100_001), companyId: COMPANY, issueId: uuid(1), key: "plan-1", body: "a".repeat(600_000), updatedAt: AT });
    const result = await loadAll(h.ctx,  h.guard);
    expect(result[0]!.texts.map((t) => t.body)).toContain("PR disposition: acme/widgets#8 defer");
    expect(result[0]!.texts.some((t) => String(t.id).startsWith("document:"))).toBe(false);
    expect(h.get).not.toHaveBeenCalled();
    for (const [sql] of h.query.mock.calls) expect(sql).not.toContain("issue_documents");
  });

  it("retains all card statuses, null project/identifier, and unrelated plugin/routine origins", async () => {
    const statuses = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"];
    const origins = ["manual", "routine_execution", "plugin:other:operation", "plugin:togetherweown.pr-doer-wake:another",
      "plugin:pr-custody-other", `${OWN}-other`, "task_watchdog"];
    const h = host({ cards: statuses.map((status, i) => card(i + 1, {
      status, origin_kind: origins[i], project_id: null, identifier: null, description: null,
      completed_at: status === "done" ? AT : null, cancelled_at: status === "cancelled" ? AT : null,
    })) });
    const result = await loadAll(h.ctx,  h.guard);
    expect(result.map((c) => c.status)).toEqual(statuses);
    expect(result.every((c) => c.projectId === null && c.identifier === null)).toBe(true);
    expect(result.find((c) => c.status === "done")?.completedAt).toBe(MS);
    expect(result.find((c) => c.status === "cancelled")?.cancelledAt).toBe(MS);
    expect(h.query.mock.calls[0]![0]).not.toMatch(/status\s*(?:=|IN)/i);
  });

  it("excludes only chat conversations and generated custody cards, not their sibling origins", async () => {
    const h = host({ cards: [
      card(1, { origin_kind: "chat_channel" }), card(2, { origin_kind: OWN }),
      card(3, { origin_kind: `${OWN}:operation` }), card(4, { origin_kind: "plugin_pr_custody" }),
      card(5, { conversation_agent_id: AGENT, conversation_user_id: "human", conversation_state: "active" }),
      card(6, { origin_kind: "plugin:other:operation" }),
    ] });
    expect((await loadAll(h.ctx,  h.guard)).map((c) => c.id)).toEqual([uuid(6)]);
    for (const [, params] of h.query.mock.calls.slice(1)) expect(params?.[3]).toBe(`{${uuid(6)}}`);
  });

  it("only agent-authored live comments establish ownership; humans still supply dispositions", async () => {
    const h = host({ comments: [
      comment(1, { body: "agent" }),
      comment(2, { body: "human", author_agent_id: null, author_user_id: "human", author_type: "user" }),
      comment(3, { body: "deleted", deleted_at: AT }),
      comment(4, { body: "legacy-agent", author_type: null }),
      comment(5, { body: "system", author_type: "system" }),
      comment(6, { body: "ambiguous", author_user_id: "human" }),
    ] });
    const result = await loadAll(h.ctx,  h.guard);
    expect(result[0]!.texts.slice(2).map(({ body, ownership }) => ({ body, ownership }))).toEqual([
      { body: "agent", ownership: true }, { body: "human", ownership: false },
      { body: "legacy-agent", ownership: true }, { body: "system", ownership: false },
      { body: "ambiguous", ownership: false },
    ]);
  });

  it("keyset-paginates without losing evidence after page one", async () => {
    const h = host({
      cards: Array.from({ length: 201 }, (_, i) => card(i + 1)),
      comments: Array.from({ length: 201 }, (_, i) => comment(i + 1)),
    });
    const result = await loadAll(h.ctx,  h.guard);
    expect(result).toHaveLength(201);
    expect(result[0]!.texts).toHaveLength(203);
    const calls = h.query.mock.calls;
    expect(calls).toHaveLength(4);
    for (const index of [1, 3]) expect(calls[index]![1]?.[1]).toBe(uuid(200));
    expect(h.get).not.toHaveBeenCalled();
    expect(h.guard).toHaveBeenCalledTimes(4);
  });

  it("allows an exactly-at-cap card view only after an exhaustion probe", async () => {
    const count = CUSTODY_READ_LIMITS.cards;
    const h = host({ cards: Array.from({ length: count }, (_, i) => card(i + 1, { description: null })) });
    expect(await loadAll(h.ctx,  h.guard)).toHaveLength(count); // metadata-only at-cap view
    const issueCalls = h.query.mock.calls.filter(([sql]) => sql.includes("FROM public.issues\n"));
    expect(issueCalls).toHaveLength(count / 200 + 1);
    expect(issueCalls.at(-1)?.[1]).toEqual([COMPANY, uuid(count), 1]);
  });

  it.each([
    ["cards", CUSTODY_READ_LIMITS.cards + 1, card, "issues"],
    ["comments", CUSTODY_READ_LIMITS.comments + 1, comment, "issue_comments"],
  ] as const)("rejects %s cap exhaustion rather than returning a partial view", async (key, count, make, table) => {
    const h = host({ [key]: Array.from({ length: count }, (_, i) => make(i + 1)) });
    await expect(loadAll(h.ctx,  h.guard)).rejects.toThrow(`UNKNOWN custody snapshot: ${table} row budget exceeded`);
    expect(h.get).not.toHaveBeenCalled();
    const relevant = h.query.mock.calls.filter(([sql]) => sql.includes(`FROM public.${table}\n`));
    expect(relevant.length).toBeLessThanOrEqual(Math.ceil(count / 200) + 1);
  });

  it.each(["issues", "issue_comments"])("rejects a cross-company %s row even if the host violates its query scope", async (table) => {
    const h = host();
    if (table !== "issues") h.query.mockResolvedValueOnce([card()]);
    h.query.mockResolvedValueOnce([{ ...(table === "issues" ? card() : comment()), company_id: OTHER }]);
    await expect(loadAll(h.ctx,  h.guard)).rejects.toThrow("cross-company");
    expect(h.get).not.toHaveBeenCalled();
  });

  it.each(["issues", "issue_comments"])("rejects duplicate %s row IDs", async (table) => {
    const h = host();
    if (table !== "issues") h.query.mockResolvedValueOnce([card()]);
    const row = table === "issues" ? card() : comment();
    h.query.mockResolvedValueOnce([row, row]);
    await expect(loadAll(h.ctx,  h.guard)).rejects.toThrow("duplicate or unordered");
  });

  it("rejects duplicate IDs across page boundaries", async () => {
    const h = host();
    h.query.mockResolvedValueOnce(Array.from({ length: 200 }, (_, i) => card(i + 1)));
    h.query.mockResolvedValueOnce([card(200)]);
    await expect(loadAll(h.ctx,  h.guard)).rejects.toThrow("duplicate or unordered");
  });

  it("rejects issue_comments linked to an unexpected issue", async () => {
    const h = host();
    h.query.mockResolvedValueOnce([card()]);
    h.query.mockResolvedValueOnce([comment(1, { issue_id: uuid(99) })]);
    await expect(loadAll(h.ctx,  h.guard)).rejects.toThrow("unexpected issue");
  });

  it.each([
    { id: "not-an-id" }, { title: 1 }, { description: undefined }, { status: "unknown" },
    { status_version: -1 }, { status_version: "9007199254740992" }, { status_version: "1.5" },
    { status_version: undefined }, { updated_at: "invalid" }, { completed_at: "invalid" },
    { assignee_agent_id: "invalid" }, { project_id: undefined }, { origin_kind: null },
  ])("rejects malformed card data: %j", async (patch) => {
    const h = host({ cards: [card(1, patch)] });
    await expect(loadAll(h.ctx,  h.guard)).rejects.toThrow("UNKNOWN custody snapshot");
  });

  it("accepts a numeric status version without deriving it from mutable timestamps", async () => {
    const h = host({ cards: [card(1, { status_version: 0, updated_at: new Date(AT) })] });
    expect((await loadAll(h.ctx,  h.guard))[0]!.statusVersion).toBe(0);
  });

  it.each([null, {}, [null], Array.from({ length: 201 }, (_, i) => card(i + 1))])("rejects malformed host page responses", async (page) => {
    const h = host();
    h.query.mockResolvedValueOnce(page as Row[]);
    await expect(loadAll(h.ctx,  h.guard)).rejects.toThrow("UNKNOWN custody snapshot");
  });

  it.each([
    ["title", "a".repeat(128_001)], ["description", "a".repeat(128_001)],
    ["description", "界".repeat(90_000)],
  ])("rejects %s character or UTF-8 body budgets", async (field, body) => {
    const h = host({ cards: [card(1, { [field]: body })] });
    await expect(loadAll(h.ctx,  h.guard)).rejects.toThrow("UNKNOWN custody snapshot");
  });

  it("rejects oversized comment bodies without truncating them", async () => {
    const comments = host({ comments: [comment(1, { body: "a".repeat(128_001) })] });
    await expect(loadAll(comments.ctx,  comments.guard)).rejects.toThrow("UNKNOWN custody snapshot");
  });

  it("rejects aggregate evidence bytes during pagination", async () => {
    const body = "a".repeat(128_000);
    const count = Math.floor(CUSTODY_READ_LIMITS.totalBytes / body.length) + 1;
    const h = host({ comments: Array.from({ length: count }, (_, i) => comment(i + 1, { body })) });
    await expect(loadAll(h.ctx,  h.guard)).rejects.toThrow("total byte budget");
    // Reject while consuming the page crossing the byte budget.
    expect(h.query).toHaveBeenCalledTimes(1 + Math.ceil(count / 200));
  });

  it.each([1, 2])("runs guard immediately before host RPC %s and stops if it throws", async (stopAt) => {
    const h = host({ comments: [comment()] });
    let count = 0;
    h.guard.mockImplementation(() => { if (++count === stopAt) throw new Error("lease expired"); });
    await expect(loadAll(h.ctx,  h.guard)).rejects.toThrow("lease expired");
    expect(h.query.mock.calls.length + h.get.mock.calls.length).toBe(stopAt - 1);
  });

  it("propagates host errors rather than returning cards already collected", async () => {
    const h = host({ comments: [comment()] });
    h.query.mockResolvedValueOnce([card()]);
    h.query.mockRejectedValueOnce(new Error("host read failed"));
    await expect(loadAll(h.ctx,  h.guard)).rejects.toThrow("host read failed");
  });

  it("returns an empty view without evidence RPCs when no cards remain", async () => {
    const h = host({ cards: [card(1, { origin_kind: OWN })] });
    expect(await loadAll(h.ctx,  h.guard)).toEqual([]);
    expect(h.query).toHaveBeenCalledTimes(1);
    expect(h.get).not.toHaveBeenCalled();
  });

  it("rejects an invalid company before any RPC", async () => {
    const h = host();
    await expect(loadCustodyCards(h.ctx, "invalid", h.guard)).rejects.toThrow("UNKNOWN custody snapshot");
    expect(h.guard).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });

  it("reads card metadata only, never company-wide comments or documents (TWO-5928)", async () => {
    const h = host({ comments: [comment()], documents: [document()] });
    const result = await loadCustodyCards(h.ctx, COMPANY, h.guard);
    expect(result[0]!.texts.map((t) => t.id)).toEqual(["title", "description"]);
    expect(h.query).toHaveBeenCalledTimes(1);
    expect(h.query.mock.calls[0]![0]).toContain("FROM public.issues");
    expect(h.get).not.toHaveBeenCalled();
  });

  it("loads texts only for the selected candidate cards, with no RPCs for an empty set", async () => {
    const h = host({ cards: [card(1), card(2)], comments: [comment(1), comment(2, { issue_id: uuid(2) })] });
    const cards = await loadCustodyCards(h.ctx, COMPANY, h.guard);
    expect(await loadCustodyTexts(h.ctx, COMPANY, h.guard, [])).toEqual([]);
    const selected = await loadCustodyTexts(h.ctx, COMPANY, h.guard, [cards[0]!]);
    expect(selected[0]!.texts.map((t) => t.id)).toContain(`comment:${uuid(1)}`);
    expect(selected[0]!.texts.map((t) => t.id)).not.toContain(`comment:${uuid(2)}`);
    const textQueries = h.query.mock.calls.filter(([, params]) => Array.isArray(params) && params.length === 4);
    expect(textQueries.length).toBeGreaterThan(0);
    for (const [, params] of textQueries) expect(params![3]).toBe(`{${uuid(1)}}`);
  });

  it("parses only explicit GitHub pull-request work-product bindings", () => {
    // A missing field is null (fail-closed UNKNOWN), never a silent []: the
    // host detail route always returns an array, so absence means the field
    // was not supplied and no proven "no bindings" claim can be made.
    expect(parseWorkProductBindings(undefined)).toBeNull();
    expect(parseWorkProductBindings(null)).toBeNull();
    expect(parseWorkProductBindings("nope")).toBeNull();
    expect(parseWorkProductBindings([])).toEqual([]);
    const parsed = parseWorkProductBindings([
      { type: "pull_request", provider: "github", url: "https://github.com/acme/widgets/pull/7", metadata: { repo: "acme/widgets", number: 7 }, externalId: "acme/widgets#7", status: "ready_for_review" },
      { type: "branch", provider: "github", url: null, metadata: null },
      { type: "pull_request", provider: "vercel", url: "x", metadata: null },
      null, "junk", 42,
    ]);
    expect(parsed).toEqual([{ type: "pull_request", provider: "github", url: "https://github.com/acme/widgets/pull/7", metadata: { repo: "acme/widgets", number: 7 }, externalId: "acme/widgets#7", status: "ready_for_review" }]);
  });
});
