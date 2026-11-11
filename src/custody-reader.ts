import type { PluginContext } from "@paperclipai/plugin-sdk";

export interface WorkProductBinding {
  type: string;
  provider: string;
  url: string | null;
  metadata: Record<string, unknown> | null;
}

export interface CustodyCard {
  id: string;
  companyId: string;
  projectId: string | null;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  statusVersion: number;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  updatedAt: number;
  completedAt: number | null;
  cancelledAt: number | null;
  texts: Array<{ id?: string; body: string; at: number; ownership: boolean }>;
  workProducts?: WorkProductBinding[];
}

// Fail-closed budgets, never truncation limits. An incomplete company view
// cannot establish that an owner/disposition is unique or absent.
//
// Scale fix (TWO-5928): the previous reader downloaded every comment (76.5 MB)
// and every linked document body for all 5,925 company cards on every tick,
// exceeding the 64 MiB total-byte budget by construction. Evidence is now
// acquired in two bounded phases:
//
//   1. loadCustodyCards reads only card metadata (titles/descriptions) for
//      the whole company. At ~24 MB this fits the 64 MiB ceiling and the
//      20k row cap, and it is sufficient for every explicit ownership tier
//      (registration, workspace branch, identifier, title/description URL,
//      work-product PR bindings).
//   2. loadCustodyTexts reads comments and document bodies only for cards
//      already mapped to a PR in the current GitHub inventory. That set is
//      bounded by the PR count, not the company card count, so the 64 MiB
//      ceiling is no longer reachable at company scale.
//
// Comment/document URL text is no longer an ownership tier: proving a
// comment-URL claim unique or absent requires the full-company history
// scan that cannot complete. Dispositions and closure rationale are still
// read from comments/documents, but only for the mapped candidate card.
const PAGE_SIZE = 200;
export const CUSTODY_READ_LIMITS = {
  cards: 20_000, comments: 100_000, documents: 10_000, totalBytes: 64 * 1024 * 1024,
} as const;
const MAX_CARDS = CUSTODY_READ_LIMITS.cards;
const MAX_COMMENTS = CUSTODY_READ_LIMITS.comments;
const MAX_DOCUMENTS = CUSTODY_READ_LIMITS.documents;
const MAX_BODY_CHARS = 128_000;
const MAX_BODY_BYTES = 256_000;
const MAX_TOTAL_BYTES = CUSTODY_READ_LIMITS.totalBytes;
const OWN_ORIGIN = "plugin:togetherweown.pr-doer-wake:pr-custody";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUSES = new Set(["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"]);
type Row = Record<string, unknown>;
type Table = "issues" | "issue_comments" | "issue_documents";

function unknown(reason: string): never {
  throw new Error(`UNKNOWN custody snapshot: ${reason}`);
}
function record(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) unknown("malformed row");
  return value as Row;
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > MAX_BODY_CHARS) unknown(`invalid ${field}`);
  return value;
}
function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : text(value, field);
}
function id(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) unknown("invalid UUID");
  return value;
}
function nullableId(value: unknown): string | null {
  return value === null ? null : id(value);
}
function time(value: unknown): number {
  // Dates are returned in-process; the worker RPC serializes them as ISO strings.
  if (!(value instanceof Date) && typeof value !== "string") unknown("invalid timestamp");
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isSafeInteger(result) || result < 0) unknown("invalid timestamp");
  return result;
}
function nullableTime(value: unknown): number | null {
  return value === null ? null : time(value);
}
function version(value: unknown): number {
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) value = Number(value);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) unknown("invalid statusVersion");
  return value;
}
function excluded(origin: string): boolean {
  return origin === "chat_channel" || origin === "plugin_pr_custody"
    || origin === OWN_ORIGIN || origin.startsWith(`${OWN_ORIGIN}:`);
}

/**
 * Parse native issue work-product PR bindings from an Issue payload's
 * `workProducts` array (when the host supplies it). Only explicit
 * pull-request bindings from GitHub are retained; malformed entries are
 * ignored rather than failing the whole snapshot because a single
 * unrelated work product must not poison custody evidence. Callers must
 * treat a binding as authoritative only through mapCustodyCard's
 * work_product tier, which revalidates repo/number/URL exactly.
 */
export function parseWorkProductBindings(raw: unknown): WorkProductBinding[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkProductBinding[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Row;
    const type = typeof row.type === "string" ? row.type : "";
    const provider = typeof row.provider === "string" ? row.provider : "";
    if (type !== "pull_request" || provider !== "github") continue;
    const url = typeof row.url === "string" ? row.url : null;
    let metadata: Record<string, unknown> | null = null;
    if (row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)) {
      metadata = row.metadata as Record<string, unknown>;
    }
    out.push({ type, provider, url, metadata });
  }
  return out;
}

function byteBudget() {
  let totalBytes = 0;
  return (body: string): void => {
    const bytes = Buffer.byteLength(body, "utf8");
    if (body.length > MAX_BODY_CHARS || bytes > MAX_BODY_BYTES) unknown("body budget exceeded");
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) unknown("total byte budget exceeded");
  };
}

/**
 * Bounded read-only company card metadata (titles/descriptions only). This is
 * a materialized view, not a cross-RPC database transaction. Any host/read/
// budget failure rejects the entire view; callers must treat rejection as
 * UNKNOWN. Comment/document evidence is loaded separately for mapped cards
 * by loadCustodyTexts, never by a full-company scan.
 */
export async function loadCustodyCards(
  ctx: PluginContext, companyId: string, guard: () => void,
): Promise<CustodyCard[]> {
  id(companyId);
  const budget = byteBudget();
  async function rows(table: Table, columns: string, cap: number, visit: (row: Row) => void, issueIds?: string[]): Promise<void> {
    let count = 0;
    let cursor: string | null = null;
    for (;;) {
      // One lookahead row proves exhaustion even when the result is exactly at cap.
      const limit = Math.min(PAGE_SIZE, cap - count + 1);
      const sql = `SELECT ${columns} FROM public.${table}
        WHERE company_id = $1 AND ($2::uuid IS NULL OR id > $2::uuid)
        ${issueIds ? "AND issue_id = ANY($4::uuid[])" : ""}
        ORDER BY id ASC LIMIT $3`;
      guard();
      // Bind an array literal as one scalar parameter: the host's SQL binder
      // expands JavaScript arrays into tuples, which are not PostgreSQL arrays.
      const page = await ctx.db.query(sql, issueIds ? [companyId, cursor, limit, `{${issueIds.join(",")}}`] : [companyId, cursor, limit]);
      if (!Array.isArray(page) || page.length > limit) unknown(`${table} malformed page`);
      for (const value of page) {
        const row = record(value);
        if (row.company_id !== companyId) unknown(`${table} cross-company row`);
        const next = id(row.id);
        if (cursor !== null && next <= cursor) unknown(`${table} duplicate or unordered row`);
        cursor = next;
        if (count === cap) unknown(`${table} row budget exceeded`);
        count++;
        visit(row);
      }
      if (page.length < limit) return;
    }
  }

  const cards = new Map<string, CustodyCard>();
  await rows("issues", `id, company_id, project_id, identifier, title, description,
    status, status_version, assignee_agent_id, assignee_user_id, origin_kind,
    conversation_agent_id, conversation_user_id, conversation_state,
    updated_at, completed_at, cancelled_at`, MAX_CARDS, (row) => {
    const origin = text(row.origin_kind, "origin_kind");
    // Chat conversations also have dedicated identity fields, independent of origin.
    const conversationAgent = nullableId(row.conversation_agent_id);
    const conversationUser = nullableText(row.conversation_user_id, "conversation_user_id");
    const conversationState = nullableText(row.conversation_state, "conversation_state");
    if (excluded(origin) || conversationAgent !== null || conversationUser !== null || conversationState !== null) return;
    const status = text(row.status, "status");
    if (!STATUSES.has(status)) unknown("invalid status");
    const card: CustodyCard = {
      id: id(row.id), companyId, projectId: nullableId(row.project_id),
      identifier: nullableText(row.identifier, "identifier"),
      title: text(row.title, "title"), description: nullableText(row.description, "description"),
      status, statusVersion: version(row.status_version), assigneeAgentId: nullableId(row.assignee_agent_id),
      assigneeUserId: nullableText(row.assignee_user_id, "assignee_user_id"),
      updatedAt: time(row.updated_at), completedAt: nullableTime(row.completed_at), cancelledAt: nullableTime(row.cancelled_at),
      texts: [],
    };
    budget(card.title);
    card.texts.push({ id: "title", body: card.title, at: card.updatedAt, ownership: true });
    if (card.description !== null) {
      budget(card.description);
      card.texts.push({ id: "description", body: card.description, at: card.updatedAt, ownership: true });
    }
    cards.set(card.id, card);
  });
  return [...cards.values()];
}

/**
 * Load comments + linked document bodies for an explicit candidate set only.
 * Appends to each card's texts in place and returns the same array. Callers
 * should pass only cards already mapped to a PR in the current inventory so
 * the byte budget tracks PR count, not company history size. Any failure
 * rejects the whole batch (fail closed): callers must treat the affected
 * PRs as UNKNOWN, never as evidence-free.
 */
export async function loadCustodyTexts(
  ctx: PluginContext, companyId: string, guard: () => void, cards: CustodyCard[],
): Promise<CustodyCard[]> {
  id(companyId);
  if (!cards.length) return cards;
  const byId = new Map<string, CustodyCard>();
  for (const card of cards) {
    if (card.companyId !== companyId) unknown("cross-company candidate card");
    if (byId.has(card.id)) continue;
    byId.set(card.id, card);
  }
  const budget = byteBudget();
  const issueIds = [...byId.keys()];
  async function rows(table: Table, columns: string, cap: number, visit: (row: Row) => void): Promise<void> {
    let count = 0;
    let cursor: string | null = null;
    for (;;) {
      const limit = Math.min(PAGE_SIZE, cap - count + 1);
      const sql = `SELECT ${columns} FROM public.${table}
        WHERE company_id = $1 AND ($2::uuid IS NULL OR id > $2::uuid)
        AND issue_id = ANY($4::uuid[])
        ORDER BY id ASC LIMIT $3`;
      guard();
      const page = await ctx.db.query(sql, [companyId, cursor, limit, `{${issueIds.join(",")}}`]);
      if (!Array.isArray(page) || page.length > limit) unknown(`${table} malformed page`);
      for (const value of page) {
        const row = record(value);
        if (row.company_id !== companyId) unknown(`${table} cross-company row`);
        const next = id(row.id);
        if (cursor !== null && next <= cursor) unknown(`${table} duplicate or unordered row`);
        cursor = next;
        if (count === cap) unknown(`${table} row budget exceeded`);
        count++;
        visit(row);
      }
      if (page.length < limit) return;
    }
  }
  function parent(row: Row): CustodyCard {
    const card = byId.get(id(row.issue_id));
    if (!card) unknown("evidence references an unexpected issue");
    return card;
  }

  await rows("issue_comments", `id, company_id, issue_id, body,
    author_agent_id, author_user_id, author_type, deleted_at, updated_at`, MAX_COMMENTS, (row) => {
    const card = parent(row);
    if (nullableTime(row.deleted_at) !== null) return;
    const agent = nullableId(row.author_agent_id);
    const user = nullableText(row.author_user_id, "author_user_id");
    const authorType = nullableText(row.author_type, "author_type");
    if (authorType !== null && !["agent", "user", "system"].includes(authorType)) unknown("invalid comment author_type");
    const body = text(row.body, "comment body");
    budget(body);
    card.texts.push({ id: `comment:${id(row.id)}`, body, at: time(row.updated_at), ownership: agent !== null && user === null && (authorType === null || authorType === "agent") });
  });

  // Never join public.documents: only metadata is an allowed core table. Scan
  // all metadata before fetching bodies so excessive documents fail without RPC fanout.
  const seenKeys = new Set<string>();
  const seenDocuments = new Set<string>();
  const documents: Array<{ card: CustodyCard; documentId: string; key: string }> = [];
  await rows("issue_documents", `id, company_id, issue_id, document_id, key, updated_at`, MAX_DOCUMENTS, (row) => {
    const card = parent(row);
    const documentId = id(row.document_id);
    const key = text(row.key, "document key");
    if (!key || key.length > 256) unknown("invalid document key");
    time(row.updated_at);
    const identity = JSON.stringify([card.id, key]);
    if (seenKeys.has(identity) || seenDocuments.has(documentId)) unknown("duplicate document metadata");
    seenKeys.add(identity);
    seenDocuments.add(documentId);
    if (key !== "pr-custody") documents.push({ card, documentId, key });
  });
  for (const { card, documentId, key } of documents) {
    guard();
    const value = await ctx.issues.documents.get(card.id, key, companyId);
    const document = record(value);
    if (document.companyId !== companyId || document.issueId !== card.id || document.id !== documentId || document.key !== key) {
      unknown("document missing or identity mismatch");
    }
    const body = text(document.body, "document body");
    budget(body);
    card.texts.push({ id: `document:${documentId}`, body, at: time(document.updatedAt), ownership: true });
  }
  return [...byId.values()];
}
