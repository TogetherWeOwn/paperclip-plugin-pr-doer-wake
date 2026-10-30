import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { parseConfig, validateConfig } from "../src/config.js";
import plugin, { runSweep } from "../src/plugin.js";
import { DB_NAMESPACE, SWEEP_JOB_KEY } from "../src/constants.js";
import {
  CARD_BY_COMMENT_SQL,
  CARD_BY_IDENTIFIER_SQL,
  clearClosedSql,
  COMMENT_EXISTS_SQL,
  claimSql,
  compactSql,
  forgetSql,
  markWakeAttemptedSql,
  reclaimSql,
  recordOutcomeSql,
  releaseWakeAttemptSql,
  retryableSql,
  seenSql,
  SETTLED_OUTCOMES,
  touchSql,
} from "../src/sql.js";

const CID = "ef993a7e-5ea7-445f-ba88-27a6a2690c3a";
const DOER = "11111111-1111-4111-8111-111111111111";
const REVIEWER = "68cba6b5-f816-4853-a3db-4389cd9ae8ca";
const CARD = "aaaaaaaa-0000-4000-8000-000000000001";
const BLOCKER = "aaaaaaaa-0000-4000-8000-000000000002";
const OTHER = "aaaaaaaa-0000-4000-8000-000000000003"; // an unrelated live card
const SECRET = "whsec-test";
const HEAD = "c05b0b5d" + "0".repeat(32);
const HEAD2 = "d15ea5e0" + "0".repeat(32);
const repository = { full_name: "TogetherWeOwn/two-web-next", default_branch: "main", owner: { login: "TogetherWeOwn" } };
const organization = { login: "TogetherWeOwn" };

type LedgerRow = {
  outcome: string; issueId: string | null; attempts: number; signal: string;
  commentPostedAt: string | null; wakeAttemptedAt: string | null; stale?: boolean; aged?: boolean; updatedAt?: string;
  /** created_at: with attempts, the claim incarnation every write of an attempt is fenced on (sql.ts claimFence). */
  createdAt?: string;
};
/** A check run as GitHub GraphQL reports it on the PR's head commit. */
type CheckRun = { id: string; name: string; status: string; conclusion: string | null; startedAt: string | null; url?: string; /** Check suite node id (default CS_1). */ suite?: string };
type Graph = {
  mergeable: string; isDraft: boolean; state?: string; head?: string; cross?: boolean; association?: string; login?: string; ref?: string; updatedAt?: string;
  /** Runs GitHub reports on the head commit; default: the delivered failing runs (RUN_ID) of build and Paperclip Review are still the latest. */
  checks?: CheckRun[];
  /** GraphQL partial errors returned beside the data (for example a token without the Checks permission). */
  errors?: Array<Record<string, unknown>>;
  /**
   * What `commits(last:1)` would return: GitHub caps the PR commits connection at 250, so on a longer PR it is not
   * the head. Default: the head.
   */
  lastCommit?: string;
};
const RUN_ID = "CR_kwDOrun100";
const RUN_STARTED = "2026-10-27T04:00:00Z";
const redRun = (conclusion = "FAILURE", name = "build"): CheckRun => ({ id: RUN_ID, name, status: "COMPLETED", conclusion, startedAt: RUN_STARTED });

let harness: TestHarness;
let ledger: Map<string, LedgerRow>;
let commentCards: Map<string, string>; // PR-link comment body -> card on which the DOER posted it (the first mention)
let laterMentions: Array<{ body: string; cardId: string; author: string }>; // later comments, oldest first
let wakes: string[];
let comments: Array<{ issueId: string; body: string }>;
let graph: Graph | null;
let graphFail: boolean;
let graphCalls: number;
let failNext: Set<string>; // one-shot faults at the wake mark and outcome write
let hostWakeCalls: number; // requestWakeup calls that reached the host, whatever the reply
let baseConfig: Record<string, unknown>;
let tick: number; // monotonic stand-in for updated_at
let onRetrySelect: (() => void) | null; // runs after the retry select returned its snapshot (another sweep racing)
let fetchGate: Promise<void> | null; // holds every GitHub call until opened
let onSeenSelect: (() => Promise<void>) | null; // runs once after a delivery's pre-check read its ledger row
let githubBody: unknown; // when set, GitHub GraphQL answers exactly this body (HTTP 200)
let pageSize: number; // GitHub's page size for check suites and check runs (the queries ask for 100)

/** The doer's PR-link comment body for PR `n`. */
const link = (n = 1903) => `PR: https://github.com/TogetherWeOwn/two-web-next/pull/${n}`;

/** Postgres ILIKE with the default escape character (backslash), for the mocked core reads. */
function ilike(value: string, pattern: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === "\\") re += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (ch === "%") re += "[\\s\\S]*";
    else if (ch === "_") re += "[\\s\\S]";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i").test(value);
}

function issue(id: string, identifier: string, status: string, extra: Record<string, unknown> = {}) {
  return { id, companyId: CID, identifier, title: identifier, status, assigneeAgentId: DOER, ...extra } as any;
}

function sign(body: string, secret = SECRET) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function deliver(event: string, payload: Record<string, unknown>, secret = SECRET) {
  const body = JSON.stringify({ organization, repository, ...payload });
  await plugin.definition.onWebhook!({
    endpointKey: "github",
    headers: { "x-github-event": event, "x-hub-signature-256": sign(body, secret), "x-github-delivery": crypto.randomUUID() },
    rawBody: body,
    parsedBody: JSON.parse(body),
    requestId: crypto.randomUUID(),
  });
}

const prEvent = (opts: { head?: string; draft?: boolean; ref?: string; action?: string; updatedAt?: string; extra?: Record<string, unknown> } = {}) => ({
  action: opts.action ?? "synchronize",
  pull_request: {
    number: 1903, state: "open", draft: opts.draft ?? false, html_url: "https://github.com/TogetherWeOwn/two-web-next/pull/1903",
    head: { sha: opts.head ?? HEAD, ref: opts.ref ?? "feat/quality", repo: { full_name: repository.full_name } },
    base: { ref: "main", repo: { full_name: repository.full_name } },
    user: { login: "doer" }, author_association: "MEMBER", updated_at: opts.updatedAt ?? new Date().toISOString(), ...(opts.extra ?? {}),
  },
});

const reviewFailed = (head = HEAD, ref = "feat/quality") => ({
  action: "completed",
  check_run: {
    id: 100, node_id: RUN_ID, started_at: RUN_STARTED,
    name: "Paperclip Review", conclusion: "failure", head_sha: head, html_url: "https://github.com/TogetherWeOwn/two-web-next/runs/9",
    output: { title: "3/5" }, pull_requests: [{ number: 1903, head: { sha: head, ref }, base: { ref: "main" } }],
  },
});

const ciFailed = (name: string, conclusion = "failure", head = HEAD, number = 1903, run: { nodeId?: string; startedAt?: string } = {}) => ({
  action: "completed",
  check_run: {
    id: 100, node_id: run.nodeId ?? RUN_ID, started_at: run.startedAt ?? RUN_STARTED,
    name, conclusion, head_sha: head, html_url: "https://github.com/x/runs/2", output: {}, pull_requests: [{ number, head: { sha: head, ref: "feat/quality" }, base: { ref: "main" } }],
  },
});
const row = (number = 1903, state = "ci_red", head = HEAD) => ledger.get(`${CID}|togetherweown/two-web-next#${number}@${head}:${state}`);

function setup(config: Record<string, unknown> = {}) {
  baseConfig = {
    enabled: true, shadow: false, githubOrg: "TogetherWeOwn",
    webhookSecretRef: { type: "secret_ref", secretId: "00000000-0000-4000-8000-000000000001" },
    githubTokenSecretRef: { type: "secret_ref", secretId: "00000000-0000-4000-8000-000000000002" },
    excludeAgentIds: [REVIEWER], ...config,
  };
  harness = createTestHarness({ manifest, config: baseConfig });
  harness.seed({
    companies: [{ id: CID, name: "TogetherWeOwn" } as any],
    issues: [issue(CARD, "TOG-43084", "in_review"), issue(BLOCKER, "TOG-1", "in_progress"), issue(OTHER, "TOG-777", "in_progress")],
  });
  ledger = new Map();
  commentCards = new Map([[link(1903), CARD]]);
  laterMentions = [];
  wakes = [];
  comments = [];
  graph = { mergeable: "MERGEABLE", isDraft: false }; // what GitHub currently says about PR 1903
  graphFail = false;
  graphCalls = 0;
  failNext = new Set();
  hostWakeCalls = 0;
  tick = 0;
  onRetrySelect = null;
  fetchGate = null;
  onSeenSelect = null;
  githubBody = undefined;
  pageSize = 100;
  const touch = () => `2026-10-27 05:00:00.${String(++tick).padStart(6, "0")}+00`;
  /** claimFence: the row still carries the attempt's claim (created_at, attempts). */
  const holds = (row: LedgerRow, createdAt: unknown, attempts: unknown) => row.createdAt === createdAt && row.attempts === attempts;
  const ctx = harness.ctx as any;
  ctx.secrets.resolve = async (ref: { secretId: string }) => (ref.secretId.endsWith("1") ? SECRET : "gh-token");
  // In-memory stand-in for the plugin namespace + the whitelisted core reads.
  ctx.db.namespace = DB_NAMESPACE;
  ctx.db.execute = async (sql: string, params: unknown[] = []) => {
    const key = `${params[0]}|${params[1]}`;
    if (sql === clearClosedSql(DB_NAMESPACE)) {
      let count = 0;
      for (const [key, row] of ledger) {
        const signal = JSON.parse(row.signal);
        if (key.startsWith(`${params[0]}|`) && signal.repo === params[1] && signal.number === params[2] && !row.wakeAttemptedAt) {
          ledger.delete(key); count++;
        }
      }
      return { rowCount: count };
    }
    if (sql === claimSql(DB_NAMESPACE)) {
      if (ledger.has(key)) return { rowCount: 0 };
      ledger.set(key, { outcome: "claimed", issueId: null, attempts: 0, signal: String(params[6]), commentPostedAt: null, wakeAttemptedAt: null, updatedAt: touch(), createdAt: String(params[7]) });
      return { rowCount: 1 };
    }
    if (sql === reclaimSql(DB_NAMESPACE)) {
      const row = ledger.get(key);
      if (!row || row.outcome !== params[2] || row.updatedAt !== params[3]) return { rowCount: 0 };
      Object.assign(row, { outcome: "retrying", attempts: row.attempts + 1, stale: false, updatedAt: String(params[4]) }); // the claim token
      return { rowCount: 1 };
    }
    if (sql === touchSql(DB_NAMESPACE)) {
      const row = ledger.get(key);
      if (!row || row.wakeAttemptedAt || !["claimed", "retrying"].includes(row.outcome)) return { rowCount: 0 };
      Object.assign(row, { signal: String(params[2]), updatedAt: `${row.updatedAt} +1us` });
      return { rowCount: 1 };
    }
    if (sql === recordOutcomeSql(DB_NAMESPACE)) {
      if (String(params[2]).startsWith("woken:") && failNext.delete("recordWoken")) {
        throw Object.assign(new Error("Worker RPC host is shutting down (budget write paused)"), { code: -32000 });
      }
      const row = ledger.get(key);
      if (!row || !holds(row, params[4], params[5])) return { rowCount: 0 };
      Object.assign(row, { outcome: params[2], issueId: params[3], updatedAt: touch() });
      return { rowCount: 1 };
    }
    if (sql === markWakeAttemptedSql(DB_NAMESPACE)) {
      if (failNext.delete("beforeWakeMark")) throw new Error("db connection reset before wake mark");
      if (failNext.delete("takenBeforeWakeMark")) {
        const taken = ledger.get(key)!;
        if (failNext.delete("forgotten")) ledger.delete(key);
        else taken.wakeAttemptedAt = "2026-10-27T05:00:00.000Z";
      }
      const row = ledger.get(key);
      if (!row || row.wakeAttemptedAt || !holds(row, params[4], params[5])) return { rowCount: 0 }; // only the claim holder, only once
      Object.assign(row, { wakeAttemptedAt: String(params[3]), issueId: params[2], updatedAt: touch() });
      if (failNext.delete("markWakeLostReply")) throw new Error("db connection reset"); // committed, reply lost
      return { rowCount: 1 };
    }
    if (sql === forgetSql(DB_NAMESPACE)) {
      const row = ledger.get(key);
      if (!row || row.wakeAttemptedAt || row.updatedAt !== params[2]) return { rowCount: 0 }; // only under its own claim token
      ledger.delete(key);
      return { rowCount: 1 };
    }
    if (sql === releaseWakeAttemptSql(DB_NAMESPACE)) {
      const row = ledger.get(key);
      if (!row || row.wakeAttemptedAt !== params[2]) return { rowCount: 0 }; // only this attempt's own mark
      Object.assign(row, { wakeAttemptedAt: null, outcome: String(params[3]), updatedAt: touch() });
      return { rowCount: 1 };
    }
    if (sql === compactSql(DB_NAMESPACE)) {
      let n = 0;
      for (const r of ledger.values()) {
        if (r.aged && r.signal !== "{}" && (SETTLED_OUTCOMES as readonly string[]).includes(r.outcome.split(":")[0]!)) { r.signal = "{}"; n += 1; }
      }
      return { rowCount: n };
    }
    throw new Error(`unexpected execute ${sql}`);
  };
  ctx.db.query = async (sql: string, params: unknown[] = []) => {
    const exclude = String(baseConfig.excludeAgentIds ?? "").split(",");
    const issues = [...[CARD, BLOCKER, OTHER].map((id) => harness.ctx.issues.get(id, CID))];
    const rows = (await Promise.all(issues)).filter(Boolean) as any[];
    // Ownership is decided regardless of status or the card's current assignee: the comment path returns up to two
    // distinct cards with a PR-link comment by any non-excluded agent (CARD_BY_COMMENT_SQL); two means ambiguous.
    if (sql === CARD_BY_IDENTIFIER_SQL) return rows.filter((r) => r.identifier === params[1]).map((r) => ({ ...r, assignee_agent_id: r.assigneeAgentId }));
    if (sql === CARD_BY_COMMENT_SQL) {
      // The statement's own predicates: c.body ilike $2 and c.body ~* $3.
      const mentions = [...[...commentCards].map(([body, cardId]) => ({ body, cardId, author: DOER })), ...laterMentions]
        .filter((m) => ilike(m.body, String(params[1])) && new RegExp(String(params[2]), "i").test(m.body) && !exclude.includes(m.author));
      const ids = [...new Set(mentions.map((m) => m.cardId))];
      return rows.filter((r) => ids.includes(r.id)).slice(0, 2).map((r) => ({ id: r.id, identifier: r.identifier, status: r.status }));
    }
    const asRow = ([k, r]: [string, LedgerRow]) => ({ fingerprint: k.split("|")[1], outcome: r.outcome, attempts: r.attempts, created_at: r.createdAt, updated_at: r.updatedAt, signal: r.signal, issue_id: r.issueId, comment_posted_at: r.commentPostedAt, wake_attempted_at: r.wakeAttemptedAt });
    if (sql === seenSql(DB_NAMESPACE)) {
      const key = `${params[0]}|${params[1]}`;
      const snapshot = ledger.has(key) ? [asRow([key, ledger.get(key)!])] : [];
      const hook = onSeenSelect;
      onSeenSelect = null;
      await hook?.(); // another attempt races this delivery after its pre-check read the row
      return snapshot;
    }
    if (sql === COMMENT_EXISTS_SQL) return comments.filter((c) => c.issueId === params[1] && c.body === params[2]).map(() => ({ id: "c" }));
    if (sql === retryableSql(DB_NAMESPACE)) {
      const snapshot = [...ledger.entries()]
        .filter(([, r]) => r.signal !== "{}" && (["error", "no_card"].includes(r.outcome) || (["claimed", "retrying"].includes(r.outcome) && r.stale))) // backoff windows: see sql.test
        .map(asRow);
      onRetrySelect?.();
      return snapshot;
    }
    throw new Error(`unexpected query ${sql}`);
  };
  ctx.http.fetch = async (_url: string, init?: { body?: string }) => {
    graphCalls += 1;
    if (fetchGate) await fetchGate;
    if (graphFail) return new Response("bad gateway", { status: 502 });
    if (githubBody !== undefined) return new Response(JSON.stringify(githubBody), { status: 200 });
    const variables = JSON.parse(init?.body ?? "{}").variables ?? {};
    const n = Number(variables.n ?? 1903);
    const runs = (graph?.checks ?? [redRun(), redRun("FAILURE", "Paperclip Review")]).map((r) => ({ url: `https://github.com/x/runs/${r.id}`, ...r }));
    const query = String(JSON.parse(init?.body ?? "{}").query ?? "");
    // Connections paged like GitHub's: `pageSize` nodes per page, the cursor is the next offset.
    const paged = <T>(all: T[], cursor: unknown) => {
      const from = cursor ? Number(cursor) : 0;
      return { pageInfo: { hasNextPage: from + pageSize < all.length, endCursor: String(from + pageSize) }, nodes: all.slice(from, from + pageSize) };
    };
    const runsPage = (suite: unknown, cursor: unknown) => {
      const { pageInfo, nodes } = paged(runs.filter((r) => (r.suite ?? "CS_1") === suite), cursor);
      return { pageInfo, nodes: nodes.map(({ suite: _suite, ...r }) => r) };
    };
    const suitesPage = (cursor: unknown) => {
      const { pageInfo, nodes } = paged([...new Set(runs.map((r) => r.suite ?? "CS_1"))], cursor);
      return { pageInfo, nodes: nodes.map((id) => ({ id, checkRuns: runsPage(id, null) })) };
    };
    if (query.includes("node(id:")) return new Response(JSON.stringify({ data: { node: { checkRuns: runsPage(variables.id, variables.runs) } } }), { status: 200 });
    if (query.includes("object(oid:")) {
      // Suites exist only on the commit GitHub lists as the PR head.
      const object = variables.oid === (graph?.head ?? HEAD) ? { checkSuites: suitesPage(variables.suites) } : { checkSuites: suitesPage("999") };
      const data = { repository: { object } };
      return new Response(JSON.stringify(graph?.errors ? { data, errors: graph.errors } : { data }), { status: 200 });
    }
    const nodes = graph ? [{
      number: n, url: `https://github.com/TogetherWeOwn/two-web-next/pull/${n}`, state: graph.state ?? "OPEN", isDraft: graph.isDraft,
      isCrossRepository: graph.cross ?? false, authorAssociation: graph.association ?? "MEMBER", author: { login: graph.login ?? "doer" },
      headRefOid: graph.head ?? HEAD, headRefName: graph.ref ?? "feat/quality", baseRefName: "main", mergeable: graph.mergeable, updatedAt: graph.updatedAt ?? new Date().toISOString(),
      ...(query.includes("checkSuites")
        ? { commits: { nodes: [{ commit: { oid: graph.lastCommit ?? graph.head ?? HEAD, checkSuites: suitesPage(graph.lastCommit ? "999" : null) } }] } }
        : {}),
    }] : [];
    const data = { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes }, pullRequest: nodes[0] ?? null } };
    return new Response(JSON.stringify(graph?.errors ? { data, errors: graph.errors } : { data }), { status: 200 });
  };
  const realWake = ctx.issues.requestWakeup.bind(ctx.issues);
  ctx.issues.requestWakeup = vi.fn(async (issueId: string, companyId: string, options: any) => {
    hostWakeCalls += 1;
    const result = await realWake(issueId, companyId, options); // harness mirrors the host guards (terminal status, blockers, assignee)
    wakes.push(`${issueId}:${options.reason}:${options.idempotencyKey}`);
    return result;
  });
  const realComment = ctx.issues.createComment.bind(ctx.issues);
  ctx.issues.createComment = async (issueId: string, body: string, companyId: string, opts?: unknown) => {
    comments.push({ issueId, body });
    return realComment(issueId, body, companyId, opts);
  };
  return plugin.definition.setup(harness.ctx);
}

describe("pr-doer-wake end to end (SDK test harness)", () => {
  beforeEach(async () => {
    await setup();
  });

  it("wakes without posting even with legacy postEvidenceComment enabled", async () => {
    await setup({ postEvidenceComment: true });
    await deliver("check_run", ciFailed("build"));
    expect(wakes).toHaveLength(1);
    expect(comments).toEqual([]);
  });

  it("closed clears never-woken retry state without erasing wake dedupe", async () => {
    graphFail = true;
    await deliver("check_run", ciFailed("build"));
    expect(row()?.outcome).toBe("error");
    graphFail = false;
    graph = { mergeable: "MERGEABLE", isDraft: false, state: "CLOSED" };
    await deliver("pull_request", prEvent({ action: "closed", extra: { state: "closed" } }));
    expect(row()).toBeUndefined();
    graph = { mergeable: "MERGEABLE", isDraft: false };
    await deliver("check_run", ciFailed("build"));
    expect(wakes).toHaveLength(1);
    graph = { mergeable: "MERGEABLE", isDraft: false, state: "CLOSED" };
    await deliver("pull_request", prEvent({ action: "closed", extra: { state: "closed" } }));
    graph = { mergeable: "MERGEABLE", isDraft: false };
    await deliver("check_run", ciFailed("build"));
    expect(wakes).toHaveLength(1);
  });

  it("ignores a delayed close when the PR has since reopened", async () => {
    graphFail = true;
    await deliver("check_run", ciFailed("build"));
    graphFail = false;
    graph = { mergeable: "MERGEABLE", isDraft: false, state: "OPEN" };
    await deliver("pull_request", prEvent({ action: "closed", extra: { state: "closed" } }));
    expect(row()?.outcome).toBe("error");
  });

  it("an accepted wake whose reply was lost (deferred: no heartbeat run) is never requested again", async () => {
    const ctx = harness.ctx as any;
    const original = ctx.issues.requestWakeup;
    ctx.issues.requestWakeup = vi.fn(async () => {
      hostWakeCalls += 1; // the host persisted a deferred wake request without a run...
      throw new Error("worker RPC timeout"); // ...and the reply never arrived
    });
    await deliver("check_run", ciFailed("build"));
    ctx.issues.requestWakeup = original;
    await harness.runJob(SWEEP_JOB_KEY);
    await harness.runJob(SWEEP_JOB_KEY);
    expect(hostWakeCalls).toBe(1);
    expect(row()!.outcome).toBe("wake_unconfirmed");
  });

  it("a retry is never credited with another fingerprint's wake on the same card", async () => {
    commentCards.set(link(1904), CARD);
    const ctx = harness.ctx as any;
    const original = ctx.issues.requestWakeup;
    ctx.issues.requestWakeup = vi.fn(async () => { throw new Error("worker RPC timeout"); });
    await deliver("check_run", ciFailed("build", "failure", HEAD, 1903));
    ctx.issues.requestWakeup = original;
    await deliver("check_run", ciFailed("build", "failure", HEAD, 1904)); // same card, woken
    expect(wakes).toHaveLength(1);
    await harness.runJob(SWEEP_JOB_KEY);
    expect(row(1904)!.outcome).toMatch(/^woken:/);
    expect(row(1903)!.outcome).not.toBe(row(1904)!.outcome); // 1904's run is not 1903's receipt
    expect(row(1903)!.outcome).toBe("wake_unconfirmed");
  });

  it("a ledger retry re-checks the card's current assignee against excludeAgentIds", async () => {
    failNext.add("beforeWakeMark"); // transient failure after the card was chosen, before any wake
    await deliver("check_run", reviewFailed());
    expect(row(1903, "review_findings")!.outcome).toBe("error");
    harness.seed({ issues: [issue(CARD, "TOG-43084", "in_review", { assigneeAgentId: REVIEWER })] }); // handed to review
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes).toEqual([]);
    expect(comments).toEqual([]);
    expect(row(1903, "review_findings")!.outcome).toBe("no_card");
    harness.seed({ issues: [issue(CARD, "TOG-43084", "in_review")] }); // back with the doer
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes).toHaveLength(1);
  });

  it("a check that arrives before the owning card links the PR stays pending and wakes once the link exists", async () => {
    commentCards.clear();
    await deliver("check_run", ciFailed("build"));
    expect(row()!.outcome).toBe("no_card");
    commentCards.set(link(1903), CARD); // the doer posts the PR URL
    await deliver("check_run", ciFailed("build")); // redelivery: already claimed
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes).toHaveLength(1);
    expect(row()!.outcome).toMatch(/^woken:/);
  });

  it("holds the wake when the branch and the PR-link comment name different cards", async () => {
    commentCards.set(link(1903), OTHER);
    graph = { mergeable: "MERGEABLE", isDraft: false, ref: "TOG-43084-quality" };
    await deliver("check_run", reviewFailed(HEAD, "TOG-43084-quality"));
    expect(wakes).toEqual([]);
    expect(comments).toEqual([]);
    expect(row(1903, "review_findings")!.outcome).toMatch(/^ambiguous_card/);
    await harness.runJob(SWEEP_JOB_KEY); // a hold, not retried
    expect(wakes).toEqual([]);
  });

  it("requires githubTokenSecretRef when enabled: every wake is revalidated against GitHub", async () => {
    const config = parseConfig({ enabled: true, githubOrg: "o", webhookSecretRef: { type: "secret_ref", secretId: "x" } });
    expect(validateConfig(config)).toEqual([expect.stringMatching(/githubTokenSecretRef/)]);
    expect(await plugin.definition.onValidateConfig!(config as any)).toMatchObject({ ok: false });
  });

  for (const [label, current] of [
    ["is now a draft", { mergeable: "MERGEABLE", isDraft: true }],
    ["is now closed", { mergeable: "MERGEABLE", isDraft: false, state: "CLOSED" }],
  ] as const) {
    it(`a webhook-known open PR that GitHub says ${label} (its pull_request delivery delayed) never wakes`, async () => {
      await deliver("pull_request", prEvent()); // indexed open, non-draft, same head
      graph = { ...current };
      await deliver("check_run", ciFailed("build"));
      await deliver("check_run", reviewFailed());
      expect(wakes).toEqual([]);
      expect(comments).toEqual([]);
    });
  }

  it("a tied updated_at cannot undo a draft conversion or reopen a closed PR", async () => {
    const t = "2026-10-27T04:00:10Z";
    await deliver("pull_request", prEvent({ action: "converted_to_draft", draft: true, updatedAt: t }));
    await deliver("pull_request", prEvent({ action: "synchronize", draft: false, updatedAt: t })); // older payload, same second
    graph = { mergeable: "MERGEABLE", isDraft: true };
    await deliver("check_run", ciFailed("build"));
    expect(wakes).toEqual([]);
    await setup();
    await deliver("pull_request", prEvent({ action: "closed", updatedAt: t, extra: { state: "closed", merged: false } }));
    await deliver("pull_request", prEvent({ action: "synchronize", updatedAt: t }));
    graph = { mergeable: "MERGEABLE", isDraft: false, state: "CLOSED" };
    await deliver("check_run", ciFailed("build"));
    expect(wakes).toEqual([]);
  });

  it("a check on a new head that arrives before (or without) its synchronize delivery still wakes", async () => {
    await deliver("pull_request", prEvent({ head: HEAD })); // the index still holds the old head
    graph = { mergeable: "MERGEABLE", isDraft: false, head: HEAD2 };
    await deliver("check_run", ciFailed("build", "failure", HEAD2));
    expect(wakes).toHaveLength(1);
  });

  it("merged PRs never wake, by default or when an old config still lists merged", async () => {
    expect((manifest.instanceConfigSchema as any).properties.wakeStates).toMatchObject({ default: ["review_findings", "ci_red", "conflict"] });
    expect(parseConfig({ wakeStates: ["merged", "ci_red"] }).wakeStates).toEqual(["ci_red"]);
    for (const config of [{}, { wakeStates: ["merged", "review_findings", "ci_red", "conflict"] }] as Record<string, unknown>[]) {
      await setup(config);
      graph = { mergeable: "MERGEABLE", isDraft: false, state: "MERGED" };
      await deliver("pull_request", prEvent({ action: "closed", extra: { state: "closed", merged: true } }));
      await deliver("check_run", ciFailed("build"));
      expect(wakes).toEqual([]);
      expect(comments).toEqual([]);
      expect(ledger.size).toBe(0);
    }
  });

  it("wakes the owning card once without creating a comment when Paperclip Review fails", async () => {
    await deliver("pull_request", prEvent());
    await deliver("check_run", reviewFailed());
    expect(wakes).toEqual([`${CARD}:github_pr_review_findings:pr-doer-wake:togetherweown/two-web-next#1903@${HEAD}:review_findings`]);
    expect(comments).toEqual([]);
    expect(ledger.get(`${CID}|togetherweown/two-web-next#1903@${HEAD}:review_findings`)!.outcome).toMatch(/^woken:/);
  });

  it("dedupes redeliveries and further failing checks on the same head; a new head wakes again", async () => {
    await deliver("pull_request", prEvent());
    await deliver("check_run", ciFailed("build"));
    await deliver("check_run", ciFailed("build"));
    await deliver("check_run", ciFailed("test"));
    expect(wakes).toHaveLength(1);
    graph = { mergeable: "MERGEABLE", isDraft: false, head: HEAD2 };
    await deliver("pull_request", prEvent({ head: HEAD2 }));
    await deliver("check_run", ciFailed("build", "failure", HEAD2));
    expect(wakes).toHaveLength(2);
  });

  it("does not wake for cancelled runs", async () => {
    await deliver("pull_request", prEvent());
    await deliver("check_run", ciFailed("pr-lint", "cancelled"));
    expect(wakes).toEqual([]);
  });

  it("never wakes for drafts", async () => {
    graph = { mergeable: "MERGEABLE", isDraft: true };
    await deliver("pull_request", prEvent({ draft: true, action: "opened" }));
    await deliver("check_run", ciFailed("build"));
    await deliver("check_run", reviewFailed());
    expect(wakes).toEqual([]);
    expect(ledger.size).toBe(0);
  });

  it("looks up a PR it has never seen a pull_request delivery for", async () => {
    graph = { mergeable: "MERGEABLE", isDraft: true };
    await deliver("check_run", ciFailed("build"));
    expect(graphCalls).toBe(1);
    expect(wakes).toEqual([]);
    graph = { mergeable: "MERGEABLE", isDraft: false, checks: [redRun()] };
    await deliver("pull_request", prEvent({ action: "ready_for_review" }));
    expect(wakes).toHaveLength(0);
    await deliver("check_run", ciFailed("build")); // redelivery: same (PR, head, state)
    expect(wakes).toHaveLength(1);
  });

  it("a company without githubTokenSecretRef is not enabled (invalid config): nothing is woken", async () => {
    await setup({ githubTokenSecretRef: undefined });
    await expect(deliver("check_run", ciFailed("build"))).rejects.toThrow(/signature/); // no enabled company to verify for
    expect(wakes).toEqual([]);
    expect(graphCalls).toBe(0);
  });

  it("rejects a bad signature and wakes nobody", async () => {
    await expect(deliver("check_run", reviewFailed(), "wrong")).rejects.toThrow(/signature/);
    expect(wakes).toEqual([]);
  });

  it("honours unresolved blockers and records the hold (no comment, no wake)", async () => {
    await harness.ctx.issues.relations.setBlockedBy?.(CARD, [BLOCKER], CID).catch(() => undefined);
    harness.seed({ issues: [issue(CARD, "TOG-43084", "in_review", { blockedBy: [{ id: BLOCKER, identifier: "TOG-1", status: "in_progress" }] })] });
    await deliver("pull_request", prEvent());
    await deliver("check_run", reviewFailed());
    expect(wakes).toEqual([]);
    expect(comments).toEqual([]);
    expect([...ledger.values()][0]!.outcome).toBe("held_blockers");
  });

  it("honours terminal and blocked status", async () => {
    for (const status of ["done", "blocked", "backlog"]) {
      await setup();
      harness.seed({ issues: [issue(CARD, "TOG-43084", status)] });
      commentCards.set(link(1903), CARD);
      await deliver("pull_request", prEvent());
      await deliver("check_run", reviewFailed());
      expect(wakes).toEqual([]);
    }
  });

  it("prefers the card named by the head branch and never picks an excluded agent's card", async () => {
    commentCards.clear();
    graph = { mergeable: "MERGEABLE", isDraft: false, ref: "TOG-43084-quality" };
    await deliver("pull_request", prEvent({ ref: "TOG-43084-quality" }));
    await deliver("check_run", reviewFailed(HEAD, "TOG-43084-quality"));
    expect(wakes).toHaveLength(1);
    await setup();
    harness.seed({ issues: [issue(CARD, "TOG-43084", "in_review", { assigneeAgentId: REVIEWER })] });
    await deliver("pull_request", prEvent());
    await deliver("check_run", reviewFailed());
    expect(wakes).toEqual([]);
    expect([...ledger.values()][0]!.outcome).toBe("no_card");
  });

  it("shadow mode records and logs but posts and wakes nothing", async () => {
    await setup({ shadow: true });
    await deliver("pull_request", prEvent());
    await deliver("check_run", reviewFailed());
    expect(wakes).toEqual([]);
    expect(comments).toEqual([]);
    expect([...ledger.values()][0]!.outcome).toBe("shadow:TOG-43084");
  });

  it("push does not schedule a conflict sweep", async () => {
    graph = { mergeable: "CONFLICTING", isDraft: false };
    await deliver("push", { ref: "refs/heads/main" });
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes).toEqual([]);
    expect(graphCalls).toBe(0);
  });

  it("a conflict synchronize never wakes a PR that GitHub reports as draft", async () => {
    graph = { mergeable: "CONFLICTING", isDraft: true };
    await deliver("pull_request", prEvent());
    expect(graphCalls).toBe(1);
    expect(wakes).toEqual([]);
  });

  it("a requestWakeup error is never retried: without a host receipt a second request could double-wake", async () => {
    const ctx = harness.ctx as any;
    const original = ctx.issues.requestWakeup;
    ctx.issues.requestWakeup = vi.fn(async () => { throw new Error("worker RPC timeout"); });
    await deliver("check_run", reviewFailed());
    expect([...ledger.values()][0]!.outcome).toBe("wake_unconfirmed");
    ctx.issues.requestWakeup = original;
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes).toEqual([]);
    expect(comments).toEqual([]);
  });

  async function failFirstWake() {
    failNext.add("beforeWakeMark"); // fails before any wake was requested: retryable
    await deliver("pull_request", prEvent());
    await deliver("check_run", reviewFailed());
    expect([...ledger.values()][0]!.outcome).toBe("error");
  }

  for (const [label, current] of [
    ["turned draft", { mergeable: "MERGEABLE", isDraft: true }],
    ["was closed", { mergeable: "MERGEABLE", isDraft: false, state: "CLOSED" }],
    ["was merged", { mergeable: "MERGEABLE", isDraft: false, state: "MERGED" }],
    ["got a new head", { mergeable: "MERGEABLE", isDraft: false, head: HEAD2 }],
  ] as const) {
    it(`a sweep retry re-reads the PR and never wakes one that ${label} (the never-woken row is forgotten)`, async () => {
      await failFirstWake();
      graph = { ...current };
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes).toEqual([]);
      expect(ledger.size).toBe(0);
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes).toEqual([]);
    });
  }

  it("a wake the host accepted but whose reply was lost is not repeated by the retry", async () => {
    const ctx = harness.ctx as any;
    const original = ctx.issues.requestWakeup;
    ctx.issues.requestWakeup = vi.fn(async (...args: any[]) => {
      await original(...args); // the host queued the run
      throw new Error("worker RPC timeout"); // ...but the reply never arrived
    });
    await deliver("pull_request", prEvent());
    await deliver("check_run", reviewFailed());
    expect(wakes).toHaveLength(1);
    expect([...ledger.values()][0]!.outcome).toBe("wake_unconfirmed");
    ctx.issues.requestWakeup = original;
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes).toHaveLength(1);
    expect(comments).toEqual([]);
    expect([...ledger.values()][0]!.outcome).toBe("wake_unconfirmed");
  });

  it("fork PRs and outsider authors never wake, even with a card-shaped head branch", async () => {
    commentCards.clear();
    graph = { mergeable: "MERGEABLE", isDraft: false, cross: true }; // GitHub: head lives in a fork
    await deliver("pull_request", prEvent({ ref: "TOG-43084-x", extra: { mergeable_state: "dirty", head: { sha: HEAD, ref: "TOG-43084-x", repo: { full_name: "evil/two-web-next" } } } }));
    await deliver("check_run", reviewFailed(HEAD, "TOG-43084-x"));
    expect(wakes).toEqual([]);
    await setup();
    commentCards.clear();
    graph = { mergeable: "MERGEABLE", isDraft: false, association: "CONTRIBUTOR" };
    await deliver("check_run", reviewFailed(HEAD, "TOG-43084-x"));
    expect(wakes).toEqual([]);
    expect(ledger.size).toBe(0);
    await setup({ trustedAuthors: ["paperclip-agent"] });
    graph = { mergeable: "MERGEABLE", isDraft: false, association: "NONE", login: "paperclip-agent[bot]" };
    await deliver("check_run", reviewFailed());
    expect(wakes).toHaveLength(1);
  });

  it("a conflict synchronize never wakes a fork PR", async () => {
    graph = { mergeable: "CONFLICTING", isDraft: false, cross: true };
    await deliver("pull_request", prEvent());
    expect(graphCalls).toBe(1);
    expect(wakes).toEqual([]);
  });

  it("a row stuck at 'claimed' after the wake was requested (worker died mid-call) is not requested again", async () => {
    const signal = { repo: "togetherweown/two-web-next", number: 1903, head: HEAD, state: "ci_red", url: "u", headRef: "feat/quality", draft: false, trusted: true, detail: {} };
    ledger.set(`${CID}|togetherweown/two-web-next#1903@${HEAD}:ci_red`, { outcome: "claimed", issueId: CARD, attempts: 0, signal: JSON.stringify(signal), commentPostedAt: new Date().toISOString(), wakeAttemptedAt: new Date().toISOString(), stale: true, updatedAt: "t0" });
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes).toEqual([]);
    expect(graphCalls).toBe(0);
    expect(row()!.outcome).toBe("wake_unconfirmed");
  });

  it("recovers a ledger row stuck at 'claimed' (worker died between claim and outcome)", async () => {
    const signal = { repo: "togetherweown/two-web-next", number: 1903, head: HEAD, state: "ci_red", url: "https://github.com/TogetherWeOwn/two-web-next/pull/1903", headRef: "feat/quality", draft: false, trusted: true, detail: { checkName: "build", checkUrl: "u", conclusion: "failure" } };
    ledger.set(`${CID}|togetherweown/two-web-next#1903@${HEAD}:ci_red`, { outcome: "claimed", issueId: null, attempts: 0, signal: JSON.stringify(signal), commentPostedAt: null, wakeAttemptedAt: null, stale: true, updatedAt: "t0" });
    graph = { mergeable: "MERGEABLE", isDraft: false };
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes).toHaveLength(1);
    expect(comments).toEqual([]);
    expect([...ledger.values()][0]!.outcome).toMatch(/^woken:/);
  });

  it("a transient PR lookup failure is kept and re-hydrated by the sweep instead of dropped", async () => {
    graphFail = true; // GitHub 5xx (same path as a secret rate-limit refusal)
    await deliver("check_run", ciFailed("build"));
    expect(wakes).toEqual([]);
    expect([...ledger.values()].map((r) => r.outcome)).toEqual(["error"]);
    graphFail = false;
    graph = { mergeable: "MERGEABLE", isDraft: false };
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes).toHaveLength(1);
  });

  it("a token resolution refusal during lookup is retryable too", async () => {
    const ctx = harness.ctx as any;
    const resolve = ctx.secrets.resolve;
    ctx.secrets.resolve = async (ref: { secretId: string }) => {
      if (ref.secretId.endsWith("2")) throw Object.assign(new Error("Rate limit exceeded for secret resolution"), { name: "RateLimitExceededError" });
      return resolve(ref);
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await deliver("check_run", ciFailed("build"));
      expect([...ledger.values()].map((r) => r.outcome)).toEqual(["error"]);
      ctx.secrets.resolve = resolve;
      graph = { mergeable: "MERGEABLE", isDraft: false };
      await harness.runJob(SWEEP_JOB_KEY); // the refusal is cached for a minute: still deferred, no resolution
      expect(wakes).toEqual([]);
      vi.setSystemTime(Date.now() + 2 * 60_000); // the next sweep after the backoff
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an older or replayed pull_request delivery never decides a wake; GitHub's current state does", async () => {
    graph = { mergeable: "MERGEABLE", isDraft: true };
    await deliver("pull_request", prEvent({ action: "converted_to_draft", draft: true, updatedAt: "2026-10-27T04:00:10Z" }));
    await deliver("pull_request", prEvent({ action: "synchronize", draft: false, updatedAt: "2026-10-27T04:00:05Z" })); // late, stale
    await deliver("check_run", ciFailed("build"));
    expect(wakes).toEqual([]);
    graph = { mergeable: "MERGEABLE", isDraft: false }; // marked ready; a check re-run fails again
    await deliver("check_run", ciFailed("build"));
    expect(wakes).toHaveLength(1);
  });

  it("a late pull_request delivery cannot reopen a closed PR", async () => {
    graph = { mergeable: "MERGEABLE", isDraft: false, state: "CLOSED" };
    await deliver("pull_request", prEvent({ action: "closed", updatedAt: "2026-10-27T04:00:10Z", extra: { state: "closed", merged: false } }));
    await deliver("pull_request", prEvent({ updatedAt: "2026-10-27T04:00:05Z", extra: { mergeable_state: "dirty" } }));
    await deliver("check_run", ciFailed("build"));
    expect(wakes).toEqual([]);
    expect(ledger.size).toBe(0);
  });

  it("a pull_request payload reporting a conflict wakes only if GitHub still says CONFLICTING", async () => {
    await deliver("pull_request", prEvent({ extra: { mergeable_state: "dirty" } }));
    expect(wakes).toEqual([]); // GitHub: MERGEABLE now
    await setup();
    graph = { mergeable: "CONFLICTING", isDraft: false };
    await deliver("pull_request", prEvent({ extra: { mergeable_state: "dirty" } }));
    expect(wakes.map((w) => w.split(":")[1])).toEqual(["github_pr_conflict"]);
  });

  it("an opened PR does not wake, even if conflicting", async () => {
    graph = { mergeable: "CONFLICTING", isDraft: false };
    await deliver("pull_request", prEvent({ action: "opened", extra: { mergeable_state: "unknown", mergeable: null } }));
    expect(wakes).toEqual([]);
    expect(graphCalls).toBe(0);
  });

  it("a conflicting head update wakes via the UNKNOWN retry path", async () => {
    graph = { mergeable: "UNKNOWN", isDraft: false, head: HEAD2 };
    await deliver("pull_request", prEvent({ head: HEAD2, extra: { mergeable_state: "unknown", mergeable: null } }));
    expect(wakes).toEqual([]);
    expect(row(1903, "conflict", HEAD2)!.outcome).toBe("error"); // deferred: GitHub still computing
    graph = { mergeable: "CONFLICTING", isDraft: false, head: HEAD2 };
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes.map((w) => w.split(":")[1])).toEqual(["github_pr_conflict"]);
    await deliver("pull_request", prEvent({ head: HEAD2, action: "synchronize" }));
    expect(wakes).toHaveLength(1); // same head, same state: at most once
  });

  it("a pull_request event on a clean PR is skipped without burning the fingerprint", async () => {
    await deliver("pull_request", prEvent({ extra: { mergeable_state: "unknown", mergeable: null } }));
    expect(wakes).toEqual([]);
    expect(row(1903, "conflict")).toBeUndefined(); // not_conflicting: nothing kept
    graph = { mergeable: "CONFLICTING", isDraft: false };
    await deliver("pull_request", prEvent({ action: "synchronize" }));
    expect(wakes).toHaveLength(1);
  });

  it("a redelivered red check costs no further GitHub lookup", async () => {
    await deliver("check_run", ciFailed("build"));
    await deliver("check_run", ciFailed("build"));
    await deliver("check_run", ciFailed("test"));
    expect(wakes).toHaveLength(1);
    expect(graphCalls).toBe(2); // the first delivery only: one PR read plus one read of the head suites
  });

  it("retries a failure before the wake mark without creating comments", async () => {
    failNext.add("beforeWakeMark");
    await deliver("check_run", reviewFailed());
    expect(comments).toEqual([]);
    expect(wakes).toEqual([]);
    expect(row(1903, "review_findings")!.outcome).toBe("error");
    await harness.runJob(SWEEP_JOB_KEY);
    expect(comments).toEqual([]);
    expect(wakes).toHaveLength(1);
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes).toHaveLength(1);
  });

  it("a lookup of a closed or merged PR never wakes it", async () => {
    for (const state of ["CLOSED", "MERGED"]) {
      await setup();
      graph = { mergeable: "MERGEABLE", isDraft: false, state };
      await deliver("check_run", ciFailed("build"));
      await deliver("check_run", ciFailed("test"));
      expect(wakes).toEqual([]);
      expect(ledger.size).toBe(0);
    }
  });

  // --- review round 3 ---------------------------------------------------------------------------------------------

  describe("retries are single-flight and re-claimed atomically", () => {
    it("a second sweep while one is still running (host job timeout < sweep time) does not run again", async () => {
      await failFirstWake();
      let open!: () => void;
      fetchGate = new Promise<void>((r) => { open = r; });
      const calls = graphCalls;
      const first = runSweep();
      await new Promise((r) => setTimeout(r, 0));
      const second = await runSweep(); // the next */5 tick, same worker
      expect(second).toEqual([]);
      expect(graphCalls - calls).toBe(1); // only the first sweep is reading GitHub
      open();
      await first;
      expect(wakes).toHaveLength(1);
      expect(comments).toEqual([]);
      expect(await runSweep()).toBeDefined(); // released afterwards
    });

    it("a retry row another sweep already re-claimed is skipped (conditional UPDATE, rowCount 0)", async () => {
      await failFirstWake();
      const key = [...ledger.keys()][0]!;
      onRetrySelect = () => {
        // another sweep re-claimed the same row between this sweep's select and its re-claim
        Object.assign(ledger.get(key)!, { outcome: "retrying", updatedAt: "2026-10-27 05:59:59.999999+00" });
      };
      const calls = graphCalls;
      await runSweep();
      expect(wakes).toEqual([]);
      expect(comments).toEqual([]);
      expect(graphCalls).toBe(calls); // no lookup either
    });

    it("a row left at 'retrying' by a dead sweep is retried, whatever its attempt count", async () => {
      await failFirstWake();
      const row0 = [...ledger.values()][0]!;
      Object.assign(row0, { outcome: "retrying", stale: true, attempts: 40 });
      await runSweep();
      expect(wakes).toHaveLength(1);
    });

    it("a never-woken row is never dropped for its retry count: it wakes once the outage ends", async () => {
      graphFail = true;
      await deliver("check_run", reviewFailed());
      for (let i = 0; i < 20; i += 1) await runSweep(); // far past the old 12-retry cap
      expect(row(1903, "review_findings")!).toMatchObject({ outcome: "error", wakeAttemptedAt: null });
      expect(row(1903, "review_findings")!.attempts).toBe(20);
      graphFail = false;
      await runSweep();
      expect(wakes).toHaveLength(1);
      await runSweep();
      expect(wakes).toHaveLength(1);
    });
  });

  describe("the failing check itself is revalidated", () => {
    it("an older failing run delivered after a newer passing run on the same head never wakes", async () => {
      await deliver("check_run", { action: "completed", check_run: { id: 200, node_id: "CR_kwDOrun200", started_at: "2026-10-27T04:05:00Z", name: "build", conclusion: "success", head_sha: HEAD, pull_requests: [{ number: 1903, head: { sha: HEAD, ref: "feat/quality" } }] } });
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [{ id: "CR_kwDOrun200", name: "build", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-27T04:05:00Z" }] };
      await deliver("check_run", ciFailed("build")); // run 100, started 04:00, delivered late
      expect(wakes).toEqual([]);
      expect(comments).toEqual([]);
      expect(ledger.size).toBe(0);
    });

    it("a retry after the flaky check was re-run green (same head) never wakes", async () => {
      await failFirstWake(); // review_findings
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [{ id: "CR_kwDOrun300", name: "Paperclip Review", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-27T04:10:00Z" }] };
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes).toEqual([]);
      expect(ledger.size).toBe(0);
    });

    it("the same run updated to passing (Paperclip Review re-scored) never wakes", async () => {
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [redRun("SUCCESS", "Paperclip Review")] };
      await deliver("check_run", reviewFailed());
      expect(wakes).toEqual([]);
    });

    it("a re-run still in progress never wakes", async () => {
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [redRun(), { id: "CR_kwDOrun101", name: "build", status: "IN_PROGRESS", conclusion: null, startedAt: null }] };
      await deliver("check_run", ciFailed("build"));
      expect(wakes).toEqual([]);
    });

    it("a newer run that failed again still wakes once", async () => {
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [{ id: "CR_kwDOrun101", name: "build", status: "COMPLETED", conclusion: "TIMED_OUT", startedAt: "2026-10-27T04:02:00Z" }] };
      await deliver("check_run", ciFailed("build"));
      expect(wakes).toHaveLength(1);
    });

    it("GitHub not showing the delivered run yet is transient, not stale", async () => {
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [{ id: "CR_kwDOrun050", name: "build", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-27T03:50:00Z" }] };
      await deliver("check_run", ciFailed("build")); // run 100 started 04:00, newer than anything GitHub lists
      expect(wakes).toEqual([]);
      expect(row()!.outcome).toBe("error");
      graph = { mergeable: "MERGEABLE", isDraft: false };
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes).toHaveLength(1);
    });
  });

  describe("ownership is resolved before eligibility", () => {
    it("a branch naming a done card never hands the wake to an unrelated live card that mentioned the PR", async () => {
      harness.seed({ issues: [issue(CARD, "TOG-43084", "done")] });
      commentCards.set(link(1903), OTHER);
      graph = { mergeable: "MERGEABLE", isDraft: false, ref: "TOG-43084-quality" };
      await deliver("check_run", reviewFailed(HEAD, "TOG-43084-quality"));
      expect(wakes).toEqual([]);
      expect(comments).toEqual([]);
      expect(row(1903, "review_findings")!.outcome).toMatch(/^ambiguous_card/);
    });

    it("a branch naming a done card with no other evidence is held on that card", async () => {
      harness.seed({ issues: [issue(CARD, "TOG-43084", "done")] });
      commentCards.clear();
      graph = { mergeable: "MERGEABLE", isDraft: false, ref: "TOG-43084-quality" };
      await deliver("check_run", reviewFailed(HEAD, "TOG-43084-quality"));
      expect(wakes).toEqual([]);
      expect(row(1903, "review_findings")!.outcome).toBe("held_status:done");
    });

    it("a branch naming a card now assigned to an excluded reviewer never wakes another card", async () => {
      harness.seed({ issues: [issue(CARD, "TOG-43084", "in_review", { assigneeAgentId: REVIEWER })] });
      commentCards.set(link(1903), OTHER);
      graph = { mergeable: "MERGEABLE", isDraft: false, ref: "TOG-43084-quality" };
      await deliver("check_run", reviewFailed(HEAD, "TOG-43084-quality"));
      expect(wakes).toEqual([]);
      expect(comments).toEqual([]);
      commentCards.clear();
      await setup();
      harness.seed({ issues: [issue(CARD, "TOG-43084", "in_review", { assigneeAgentId: REVIEWER })] });
      commentCards.clear();
      graph = { mergeable: "MERGEABLE", isDraft: false, ref: "TOG-43084-quality" };
      await deliver("check_run", reviewFailed(HEAD, "TOG-43084-quality"));
      expect(wakes).toEqual([]);
      expect(row(1903, "review_findings")!).toMatchObject({ outcome: "no_card", issueId: CARD }); // pending on the owner
    });
  });

  describe("wake attempts that provably never reached the host are retried", () => {
    it("a wake mark whose DB reply was lost (requestWakeup never called) is retried and wakes once", async () => {
      failNext.add("markWakeLostReply");
      await deliver("check_run", ciFailed("build"));
      expect(hostWakeCalls).toBe(0);
      await harness.runJob(SWEEP_JOB_KEY);
      expect(hostWakeCalls).toBe(1);
      expect(row()!.outcome).toMatch(/^woken:/);
      await harness.runJob(SWEEP_JOB_KEY);
      expect(hostWakeCalls).toBe(1);
    });

    it("a host refusal before dispatch (WORKER_UNAVAILABLE, idle hold) is retried and wakes once", async () => {
      const ctx = harness.ctx as any;
      const original = ctx.issues.requestWakeup;
      ctx.issues.requestWakeup = vi.fn(async () => { throw Object.assign(new Error("Plugin is held for idle sleep"), { code: -32000 }); });
      await deliver("check_run", ciFailed("build"));
      expect(row()!).toMatchObject({ outcome: "error", wakeAttemptedAt: null });
      ctx.issues.requestWakeup = original;
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes).toHaveLength(1);
      expect(comments).toEqual([]);
    });
  });

  it("ledger retention keeps a compact dedupe tombstone: an aged wake for a still-open PR never wakes again", async () => {
    graph = { mergeable: "CONFLICTING", isDraft: false };
    await deliver("pull_request", prEvent());
    expect(wakes).toHaveLength(1);
    for (const r of ledger.values()) r.aged = true; // 30 days later
    await harness.runJob(SWEEP_JOB_KEY);
    expect([...ledger.values()].map((r) => r.signal)).toEqual(["{}"]);
    await deliver("pull_request", prEvent()); // same PR, same head, still conflicting
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes).toHaveLength(1);
  });

  describe("stoppedRepos applies to scheduled work too", () => {
    it("a retry row for a repo stopped after the first attempt never wakes", async () => {
      graphFail = true;
      await deliver("check_run", ciFailed("build"));
      expect(row()!.outcome).toBe("error");
      graphFail = false;
      harness.setConfig({ ...baseConfig, stoppedRepos: ["togetherweown/two-web-next"] });
      const calls = graphCalls;
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes).toEqual([]);
      expect(graphCalls).toBe(calls);
      expect(row()).toBeUndefined(); // never woken: forgotten
    });

    it("a pending conflict retry for a repo stopped after synchronize never wakes or rereads GitHub", async () => {
      graphFail = true;
      await deliver("pull_request", prEvent());
      expect(row(1903, "conflict")!.outcome).toBe("error");
      graphFail = false;
      const calls = graphCalls;
      harness.setConfig({ ...baseConfig, stoppedRepos: ["togetherweown/two-web-next"] });
      graph = { mergeable: "CONFLICTING", isDraft: false };
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes).toEqual([]);
      expect(graphCalls).toBe(calls);
      expect(row(1903, "conflict")).toBeUndefined();
    });

    it("the final guard in wakeForSignal refuses a stopped repo whatever the caller", async () => {
      const { wakeForSignal } = await import("../src/waker.js");
      const config = parseConfig({ ...baseConfig, stoppedRepos: ["togetherweown/two-web-next"] });
      const signal = { repo: "togetherweown/two-web-next", number: 1903, head: HEAD, state: "ci_red" as const, url: "u", headRef: null, draft: false, trusted: true, detail: {} };
      expect(await wakeForSignal(harness.ctx, CID, config, signal)).toMatchObject({ outcome: "stopped_repo" });
      expect(ledger.size).toBe(0);
      expect(wakes).toEqual([]);
    });
  });

  // --- review round 4: at-most-once spec (2026-10-27) ----------------------------------------------------------------

  describe("temporary skips never burn the fingerprint", () => {
    it("a flaky check re-run that fails again (new run id) after a stale check_not_red retry still wakes once", async () => {
      graphFail = true;
      await deliver("check_run", ciFailed("build"));
      expect(row()!.outcome).toBe("error");
      graphFail = false;
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [{ id: "CR_kwDOrun101", name: "build", status: "IN_PROGRESS", conclusion: null, startedAt: "2026-10-27T04:05:00Z" }, redRun()] };
      await harness.runJob(SWEEP_JOB_KEY); // the re-run is in progress: not red now
      expect(wakes).toEqual([]);
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [{ id: "CR_kwDOrun101", name: "build", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-27T04:05:00Z" }, redRun()] };
      await deliver("check_run", ciFailed("build", "failure", HEAD, 1903, { nodeId: "CR_kwDOrun101", startedAt: "2026-10-27T04:05:00Z" }));
      expect(wakes).toHaveLength(1);
      await deliver("check_run", ciFailed("build", "failure", HEAD, 1903, { nodeId: "CR_kwDOrun101", startedAt: "2026-10-27T04:05:00Z" }));
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes).toHaveLength(1);
    });

    for (const [label, temporary] of [
      ["a draft", { mergeable: "MERGEABLE", isDraft: true }],
      ["an untrusted author", { mergeable: "MERGEABLE", isDraft: false, association: "NONE" }],
    ] as const) {
      it(`a retry that finds ${label} does not stop a later genuine red on the same head`, async () => {
        graphFail = true;
        await deliver("check_run", ciFailed("build"));
        graphFail = false;
        graph = { ...temporary };
        await harness.runJob(SWEEP_JOB_KEY);
        expect(wakes).toEqual([]);
        graph = { mergeable: "MERGEABLE", isDraft: false };
        await deliver("check_run", ciFailed("build", "failure", HEAD, 1903, { nodeId: "CR_kwDOrun102", startedAt: "2026-10-27T04:06:00Z" }));
        expect(wakes).toHaveLength(1);
      });
    }

    it("a row an earlier build closed as stale:<reason> is resumed by a later genuine signal", async () => {
      const signal = { repo: "togetherweown/two-web-next", number: 1903, head: HEAD, state: "ci_red", url: "u", headRef: "feat/quality", draft: false, trusted: true, detail: { checkName: "build", checkRunId: RUN_ID, checkStartedAt: RUN_STARTED } };
      ledger.set(`${CID}|togetherweown/two-web-next#1903@${HEAD}:ci_red`, { outcome: "stale:check_not_red", issueId: null, attempts: 1, signal: JSON.stringify(signal), commentPostedAt: null, wakeAttemptedAt: null, updatedAt: "t0" });
      await deliver("check_run", ciFailed("build", "failure", HEAD, 1903, { nodeId: "CR_kwDOrun103" }));
      expect(wakes).toHaveLength(1);
    });

    it("a conflict retry that finds the PR no longer conflicting does not stop a later conflict on the same head", async () => {
      graph = { mergeable: "UNKNOWN", isDraft: false };
      await deliver("pull_request", prEvent({ extra: { mergeable_state: "dirty" } }));
      expect(row(1903, "conflict")!.outcome).toBe("error");
      graph = { mergeable: "MERGEABLE", isDraft: false };
      await harness.runJob(SWEEP_JOB_KEY);
      expect(row(1903, "conflict")).toBeUndefined();
      graph = { mergeable: "CONFLICTING", isDraft: false };
      await deliver("pull_request", prEvent());
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes.map((w) => w.split(":")[1])).toEqual(["github_pr_conflict"]);
    });
  });

  describe("a GitHub outage never strands a wake that was never attempted", () => {
    it("a redelivery that meets a row with many retries behind it resumes it and wakes once", async () => {
      graphFail = true;
      await deliver("check_run", ciFailed("build"));
      row()!.attempts = 50;
      graphFail = false;
      await deliver("check_run", ciFailed("build"));
      expect(wakes).toHaveLength(1);
      expect(row()!.outcome).toMatch(/^woken:/);
    });

    it("an outage spanning the delivery and many sweeps is recovered by the next sweep after it ends", async () => {
      graphFail = true;
      await deliver("check_run", ciFailed("build"));
      for (let i = 0; i < 6; i += 1) await harness.runJob(SWEEP_JOB_KEY);
      expect(row()!).toMatchObject({ outcome: "error", wakeAttemptedAt: null });
      graphFail = false;
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes).toHaveLength(1);
    });

    it("an authenticated redelivery resumes a row whose wake was never attempted, at once", async () => {
      graphFail = true;
      await deliver("check_run", ciFailed("build"));
      await harness.runJob(SWEEP_JOB_KEY);
      graphFail = false;
      await deliver("check_run", ciFailed("build")); // GitHub "Redeliver"
      expect(wakes).toHaveLength(1);
      await deliver("check_run", ciFailed("build"));
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes).toHaveLength(1);
    });

    it("a redelivery never resumes a row whose wake may already have reached the host", async () => {
      const ctx = harness.ctx as any;
      const original = ctx.issues.requestWakeup;
      ctx.issues.requestWakeup = vi.fn(async () => { hostWakeCalls += 1; throw new Error("worker RPC timeout"); });
      await deliver("check_run", ciFailed("build"));
      ctx.issues.requestWakeup = original;
      await deliver("check_run", ciFailed("build"));
      await harness.runJob(SWEEP_JOB_KEY);
      expect(hostWakeCalls).toBe(1);
      expect(row()!.outcome).toBe("wake_unconfirmed");
    });
  });

  it("a second failing check on the same head is not lost when the first one recovers before the retry", async () => {
    graphFail = true;
    await deliver("check_run", ciFailed("build")); // GitHub down: pending
    await deliver("check_run", ciFailed("test", "failure", HEAD, 1903, { nodeId: "CR_kwDOtest1" })); // same fingerprint
    expect(wakes).toEqual([]);
    graphFail = false;
    graph = {
      mergeable: "MERGEABLE", isDraft: false,
      checks: [
        { id: "CR_kwDOrun200", name: "build", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-27T04:05:00Z" },
        { id: "CR_kwDOtest1", name: "test", status: "COMPLETED", conclusion: "FAILURE", startedAt: RUN_STARTED },
      ],
    };
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes).toHaveLength(1);
    expect(comments).toEqual([]);
  });

  describe("a signal that meets an attempt in flight is never acknowledged as settled", () => {
    const green: CheckRun = { id: "CR_kwDOrun200", name: "build", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-27T04:05:00Z" };
    const testRed: CheckRun = { id: "CR_kwDOtest1", name: "test", status: "COMPLETED", conclusion: "FAILURE", startedAt: RUN_STARTED };
    /** Start a sweep and return once its retry holds the row and waits on GitHub (gated), plus the gate opener. */
    async function sweepHeldOnGithub(): Promise<{ sweep: Promise<unknown>; open: () => void }> {
      let open!: () => void;
      fetchGate = new Promise<void>((r) => { open = r; });
      const calls = graphCalls;
      const sweep = runSweep();
      while (graphCalls === calls) await new Promise((r) => setTimeout(r, 0));
      return { sweep, open: () => { fetchGate = null; open(); } };
    }

    it("a new gating failure delivered while a retry reads a green snapshot still wakes once", async () => {
      graphFail = true;
      await deliver("check_run", ciFailed("build")); // pending
      graphFail = false;
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [green] }; // build recovered; test not finished yet
      const { sweep, open } = await sweepHeldOnGithub();
      expect(row()!.outcome).toBe("retrying");
      await deliver("check_run", ciFailed("test", "failure", HEAD, 1903, { nodeId: "CR_kwDOtest1" })); // same fingerprint
      open();
      await sweep; // its snapshot predates the test failure: green, but the row was touched, so it is kept
      expect(wakes).toEqual([]);
      expect(row()).toMatchObject({ outcome: "error", wakeAttemptedAt: null });
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [green, testRed] };
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes).toHaveLength(1);
      expect(comments).toEqual([]);
      await deliver("check_run", ciFailed("test", "failure", HEAD, 1903, { nodeId: "CR_kwDOtest1" }));
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes).toHaveLength(1);
    });

    it("a redelivery that loses its resume to a sweep folds into that sweep instead of being dropped", async () => {
      graphFail = true;
      await deliver("check_run", ciFailed("build"));
      graphFail = false;
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [green] };
      let held!: { sweep: Promise<unknown>; open: () => void };
      onSeenSelect = async () => { held = await sweepHeldOnGithub(); }; // the sweep re-claims between pre-check and resume
      await deliver("check_run", ciFailed("test", "failure", HEAD, 1903, { nodeId: "CR_kwDOtest1" }));
      held.open();
      await held.sweep;
      expect(wakes).toEqual([]);
      expect(row()).toMatchObject({ outcome: "error", wakeAttemptedAt: null });
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [green, testRed] };
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes).toHaveLength(1);
    });

    it("a redelivery folded into an attempt keeps the delivered run's identity", async () => {
      await setup({ wakeStates: ["ci_red"] });
      graphFail = true;
      await deliver("check_run", ciFailed("build"));
      graphFail = false;
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [] }; // GitHub does not list the delivered run yet
      const { sweep, open } = await sweepHeldOnGithub();
      const priorVersion = row()!.updatedAt;
      await deliver("check_run", ciFailed("build")); // folded: no GitHub read of its own
      expect(row()!.updatedAt).not.toBe(priorVersion);
      open();
      await sweep;
      expect(JSON.parse(row()!.signal).detail).toMatchObject({ checkName: "build", checkRunId: RUN_ID });
      await harness.runJob(SWEEP_JOB_KEY); // still lagging: kept, not forgotten as check_not_red
      expect(row()!.outcome).toBe("error");
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [redRun()] };
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes).toHaveLength(1);
    });

    it("a signal folded into an attempt that then wakes is never woken a second time", async () => {
      graphFail = true;
      await deliver("check_run", ciFailed("build"));
      graphFail = false;
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [redRun(), testRed] };
      const { sweep, open } = await sweepHeldOnGithub();
      await deliver("check_run", ciFailed("test", "failure", HEAD, 1903, { nodeId: "CR_kwDOtest1" }));
      open();
      await sweep;
      expect(wakes).toHaveLength(1);
      await harness.runJob(SWEEP_JOB_KEY);
      await deliver("check_run", ciFailed("test", "failure", HEAD, 1903, { nodeId: "CR_kwDOtest1" }));
      expect(hostWakeCalls).toBe(1);
    });
  });

  it("a delivered run GitHub still lists as in progress (read lag) is retried, not dropped", async () => {
    graph = { mergeable: "MERGEABLE", isDraft: false, checks: [{ ...redRun(), status: "IN_PROGRESS", conclusion: null }] };
    await deliver("check_run", ciFailed("build"));
    expect(wakes).toEqual([]);
    expect(row()!.outcome).toBe("error");
    graph = { mergeable: "MERGEABLE", isDraft: false };
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes).toHaveLength(1);
  });

  it("a PR past GitHub's 250-commit cap still has its head checks read (by head oid, not commits(last:1))", async () => {
    graph = { mergeable: "MERGEABLE", isDraft: false, lastCommit: "e".repeat(40) };
    await deliver("check_run", ciFailed("build"));
    expect(wakes).toHaveLength(1);
  });

  it("a GitHub token without the Checks permission is reported as a config error and the signal is kept", async () => {
    graph = {
      mergeable: "MERGEABLE", isDraft: false,
      errors: [{ type: "FORBIDDEN", path: ["repository", "object", "checkSuites"], message: "Resource not accessible by personal access token" }],
    };
    await deliver("check_run", ciFailed("build"));
    expect(wakes).toEqual([]);
    expect(row()!.outcome).toBe("error");
    const errors = harness.logs.filter((l) => l.level === "error");
    expect(errors.map((l) => l.message)).toEqual([expect.stringMatching(/GitHub token cannot see the repository or lacks a permission/)]);
    expect(JSON.stringify(errors[0]!.meta)).toMatch(/checkSuites/);
    graph = { mergeable: "MERGEABLE", isDraft: false }; // token fixed
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes).toHaveLength(1);
  });

  describe("only one attempt may request a wake (conditional wake mark)", () => {
    for (const forgotten of [true, false]) {
      it(`a stalled attempt whose row another attempt ${forgotten ? "forgot" : "already marked"} never requests the wake`, async () => {
        failNext.add("takenBeforeWakeMark");
        if (forgotten) failNext.add("forgotten");
        await deliver("check_run", ciFailed("build"));
        expect(hostWakeCalls).toBe(0);
      });
    }
  });

  describe("comment ownership survives the owner's reassignment", () => {
    it("an owning card handed to the excluded reviewer is still the owner: pending on it, never another card", async () => {
      harness.seed({ issues: [issue(CARD, "TOG-43084", "in_review", { assigneeAgentId: REVIEWER })] });
      await deliver("check_run", reviewFailed());
      expect(wakes).toEqual([]);
      expect(comments).toEqual([]);
      expect(row(1903, "review_findings")!).toMatchObject({ outcome: "no_card", issueId: CARD }); // pending on the owner
      harness.seed({ issues: [issue(CARD, "TOG-43084", "in_review")] }); // back with the doer
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes.map((w) => w.split(":")[0])).toEqual([CARD]);
    });

    it("PR-link comments by an excluded agent never establish ownership", async () => {
      commentCards.clear();
      laterMentions.push({ body: link(1903), cardId: OTHER, author: REVIEWER });
      await deliver("check_run", reviewFailed());
      expect(wakes).toEqual([]);
      expect(row(1903, "review_findings")!.outcome).toBe("no_card");
    });
  });

  // --- review round 4 ---------------------------------------------------------------------------------------------

  describe("a wake that reached the host is never requested twice", () => {
    it("a failed outcome write after requestWakeup succeeded (even -32000 or a 'budget'/'paused' message) never wakes again", async () => {
      failNext.add("recordWoken");
      await deliver("check_run", ciFailed("build"));
      expect(hostWakeCalls).toBe(1);
      expect(row()!.wakeAttemptedAt).not.toBeNull(); // the mark stays: the wake happened
      expect(row()!.outcome).not.toMatch(/^refused/);
      await harness.runJob(SWEEP_JOB_KEY);
      await harness.runJob(SWEEP_JOB_KEY);
      await deliver("check_run", ciFailed("build"));
      expect(hostWakeCalls).toBe(1);
      expect(wakes).toHaveLength(1);
    });
  });

  it("the SDK's own -32000 on shutdown (the request may have been dispatched) is unconfirmed, never retried", async () => {
    const ctx = harness.ctx as any;
    const original = ctx.issues.requestWakeup;
    ctx.issues.requestWakeup = vi.fn(async () => {
      hostWakeCalls += 1; // sent; the host may have queued it...
      throw Object.assign(new Error("Worker RPC host is shutting down"), { code: -32000 }); // ...cleanup() rejected the pending call
    });
    await deliver("check_run", ciFailed("build"));
    ctx.issues.requestWakeup = original;
    expect(row()!.outcome).toBe("wake_unconfirmed");
    await harness.runJob(SWEEP_JOB_KEY);
    expect(hostWakeCalls).toBe(1);
  });

  it("a comment linking the same path on another host never makes an unrelated card the owner", async () => {
    commentCards.clear();
    laterMentions.push({ body: "see https://notgithub.com/togetherweown/two-web-next/pull/1903", cardId: OTHER, author: DOER });
    await deliver("check_run", ciFailed("build")); // branch feat/quality names no card
    expect(wakes).toEqual([]);
    expect(comments).toEqual([]);
    expect(row()!.outcome).toBe("no_card");
  });

  describe("ownership is ambiguous when PR-link comments name several cards", () => {
    const PR = link(1903);
    it("an unrelated card that linked the PR first never gets the wake: held as ambiguous_card", async () => {
      commentCards.set(PR, OTHER); // card A mentioned the PR first
      laterMentions.push({ body: PR, cardId: CARD, author: DOER }); // the real owner B links it afterwards
      await deliver("check_run", reviewFailed()); // branch feat/quality names no card
      expect(wakes).toEqual([]);
      expect(comments).toEqual([]);
      expect(row(1903, "review_findings")!.outcome).toMatch(/^ambiguous_card/);
      await harness.runJob(SWEEP_JOB_KEY); // a hold, not retried
      expect(wakes).toEqual([]);
    });

    it("comments on a second card make even a branch-named owner ambiguous", async () => {
      laterMentions.push({ body: PR, cardId: OTHER, author: DOER });
      graph = { mergeable: "MERGEABLE", isDraft: false, ref: "TOG-43084-quality" };
      await deliver("check_run", reviewFailed(HEAD, "TOG-43084-quality"));
      expect(wakes).toEqual([]);
      expect(row(1903, "review_findings")!.outcome).toMatch(/^ambiguous_card/);
    });

    it("a retry re-resolves ownership and holds when new evidence conflicts with the card it chose", async () => {
      commentCards.clear(); // only the branch names the card
      graph = { mergeable: "MERGEABLE", isDraft: false, ref: "TOG-43084-quality" };
      failNext.add("beforeWakeMark");
      await deliver("check_run", reviewFailed(HEAD, "TOG-43084-quality"));
      expect(row(1903, "review_findings")!).toMatchObject({ outcome: "error", issueId: CARD });
      commentCards.set(PR, OTHER); // another card now carries a qualifying PR-link comment
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes).toEqual([]);
      expect(comments).toEqual([]);
      expect(row(1903, "review_findings")!.outcome).toMatch(/^ambiguous_card/);
    });

    it("a retry holds when the card it chose no longer resolves as the owner", async () => {
      failNext.add("beforeWakeMark");
      await deliver("check_run", reviewFailed());
      expect(row(1903, "review_findings")!).toMatchObject({ outcome: "error", issueId: CARD });
      commentCards.set(PR, OTHER); // the evidence now points at another card only
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes).toEqual([]);
      expect(row(1903, "review_findings")!.outcome).toMatch(/^ambiguous_card/);
    });
  });

  describe("pending conflict retries survive outages", () => {
    it("retries a synchronize signal throughout a prolonged GitHub outage", async () => {
      graphFail = true;
      await deliver("pull_request", prEvent());
      for (let i = 0; i < 10; i += 1) await harness.runJob(SWEEP_JOB_KEY);
      expect(row(1903, "conflict")!.outcome).toBe("error");
      graphFail = false;
      graph = { mergeable: "CONFLICTING", isDraft: false };
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes.map((w) => w.split(":")[1])).toEqual(["github_pr_conflict"]);
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes).toHaveLength(1);
    });
    it("keeps a synchronize signal pending while mergeability is unknown", async () => {
      graph = { mergeable: "UNKNOWN", isDraft: false };
      await deliver("pull_request", prEvent());
      for (let i = 0; i < 10; i += 1) await harness.runJob(SWEEP_JOB_KEY);
      expect(row(1903, "conflict")!.outcome).toBe("error");
      graph = { mergeable: "CONFLICTING", isDraft: false };
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes).toHaveLength(1);
    });
  });

  describe("host refusals are recognised by the host's exact pre-queue messages", () => {
    /** What the SDK rejects with when the host handler threw (JsonRpcCallError, INTERNAL_ERROR -32603). */
    const hostError = (message: string) => Object.assign(new Error(message), { name: "JsonRpcCallError", code: -32603 });
    async function refuseOnce(message: string) {
      const ctx = harness.ctx as any;
      const original = ctx.issues.requestWakeup;
      ctx.issues.requestWakeup = vi.fn(async () => {
        hostWakeCalls += 1;
        ctx.issues.requestWakeup = original;
        throw hostError(message);
      });
    }
    const unconfirmedLogs = () => harness.logs.filter((l) => l.message === "pr-doer-wake: wake_unconfirmed (request sent, result unknown; not repeated)");

    for (const message of [
      "Agent is not invokable in its current state", // paused, terminated or pending agent (agent-invokability.ts)
      "Agent is not invokable because its reporting chain is invalid",
      "Agent no longer exists",
      "Agent not found",
      "Issue has no assigned agent to wake",
      "Issue is not wakeable in status: done",
      "Issue is blocked by unresolved blockers",
      "Agent cannot start work because recorded usage has no reliable price.",
      "Project cannot start work because its budget hard-stop is still exceeded.",
      "Company is paused because its budget hard-stop was reached.",
      "Project is paused and cannot start new work.",
      "Budget pause requires a policy or an explicit operator resume.",
    ]) {
      it(`"${message}" is a refusal, never a wake_unconfirmed`, async () => {
        await refuseOnce(message);
        await deliver("check_run", ciFailed("build"));
        expect(row()!.outcome).toBe(`refused:${message}`.slice(0, 129));
        expect(unconfirmedLogs()).toHaveLength(0);
        await harness.runJob(SWEEP_JOB_KEY);
        expect(hostWakeCalls).toBe(1); // a refusal is a decision: not retried
      });
    }

    for (const message of [
      "Company cannot start work while completed runs await accounting.",
      "Agent cannot start work while completed runs await accounting.",
      "New work must wait while a native run recovers its unfinished accounting.",
    ]) {
      it(`"${message}" (temporary, nothing queued) releases the mark and the sweep wakes once`, async () => {
        await refuseOnce(message);
        await deliver("check_run", ciFailed("build"));
        expect(row()!).toMatchObject({ outcome: "error", wakeAttemptedAt: null });
        expect(unconfirmedLogs()).toHaveLength(0);
        await harness.runJob(SWEEP_JOB_KEY);
        expect(wakes).toHaveLength(1);
        expect(row()!.outcome).toMatch(/^woken:/);
        await harness.runJob(SWEEP_JOB_KEY);
        expect(hostWakeCalls).toBe(2);
      });
    }

    it("a message that merely mentions budget or paused is not a refusal (no substring guessing)", async () => {
      await refuseOnce("worker RPC timeout while the budget write was paused");
      await deliver("check_run", ciFailed("build"));
      expect(row()!.outcome).toBe("wake_unconfirmed");
      expect(unconfirmedLogs()).toHaveLength(1);
    });
  });

  describe("GitHub NOT_FOUND: a PR gone from a visible repo is closed; a repository the token cannot see is a config error", () => {
    const repoGone = {
      data: { repository: null },
      errors: [{ type: "NOT_FOUND", path: ["repository"], locations: [{ line: 1, column: 63 }], message: "Could not resolve to a Repository with the name 'TogetherWeOwn/two-web-next'." }],
    };
    const prGone = {
      data: { repository: { pullRequest: null } },
      errors: [{ type: "NOT_FOUND", path: ["repository", "pullRequest"], locations: [{ line: 2, column: 1 }], message: "Could not resolve to a PullRequest with the number of 1903." }],
    };

    for (const [label, body] of [["pull request", prGone]] as const) {
      it(`a pending row whose ${label} no longer exists is forgotten, not re-read forever`, async () => {
        graphFail = true;
        await deliver("check_run", ciFailed("build"));
        expect(row()!.outcome).toBe("error");
        graphFail = false;
        githubBody = body;
        await harness.runJob(SWEEP_JOB_KEY);
        expect(ledger.size).toBe(0);
        const calls = graphCalls;
        await harness.runJob(SWEEP_JOB_KEY);
        expect(graphCalls).toBe(calls);
        expect(wakes).toEqual([]);
      });

      it(`a delivery for a ${label} GitHub cannot find writes no row and wakes nobody`, async () => {
        githubBody = body;
        await deliver("check_run", ciFailed("build"));
        expect(ledger.size).toBe(0);
        expect(wakes).toEqual([]);
      });
    }

    const tokenErrors = () => harness.logs.filter((l) => l.level === "error" && /GitHub token cannot see the repository or lacks a permission/.test(l.message));

    it("a delivery for a repository the token cannot see is kept as a config error and wakes once the token can see it", async () => {
      githubBody = repoGone;
      await deliver("check_run", ciFailed("build"));
      expect(row()!).toMatchObject({ outcome: "error", wakeAttemptedAt: null });
      expect(tokenErrors()).toHaveLength(1);
      expect(JSON.stringify(tokenErrors()[0]!.meta)).toMatch(/NOT_FOUND/);
      await harness.runJob(SWEEP_JOB_KEY);
      expect(row()!.outcome).toBe("error"); // retried with backoff (hourly at most), never treated as closed
      githubBody = undefined; // token fixed
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes).toHaveLength(1);
    });

    it("a pending row whose repository the token cannot see is kept, not forgotten", async () => {
      graphFail = true;
      await deliver("check_run", ciFailed("build"));
      graphFail = false;
      githubBody = repoGone;
      await harness.runJob(SWEEP_JOB_KEY);
      expect(row()!.outcome).toBe("error");
      githubBody = undefined;
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes).toHaveLength(1);
    });

    it("a pending conflict is kept when the repository is invisible and wakes once it becomes visible", async () => {
      githubBody = repoGone;
      await deliver("pull_request", prEvent());
      await harness.runJob(SWEEP_JOB_KEY);
      expect(tokenErrors().length).toBeGreaterThan(0);
      expect(row(1903, "conflict")!.outcome).toBe("error");
      githubBody = undefined;
      graph = { mergeable: "CONFLICTING", isDraft: false };
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes.map((w) => w.split(":")[1])).toEqual(["github_pr_conflict"]);
    });

    it("any other GraphQL error stays transient: the signal is kept", async () => {
      githubBody = { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for installation." }] };
      await deliver("check_run", ciFailed("build"));
      expect(row()!.outcome).toBe("error");
      githubBody = { data: { repository: null }, errors: [{ type: "NOT_FOUND", path: ["viewer"], message: "x" }, { type: "INTERNAL", path: ["repository"], message: "y" }] };
      await harness.runJob(SWEEP_JOB_KEY);
      expect(row()!.outcome).toBe("error");
      githubBody = undefined;
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes).toHaveLength(1);
    });
  });

  describe("a superseded attempt never overrides the attempt that took its row", () => {
    /** Stall immediately before the conditional wake mark, allowing a retry to take the claim. */
    async function stallBeforeWakeMark(): Promise<{ delivery: Promise<void>; resume: () => void }> {
      const ctx = harness.ctx as any;
      const execute = ctx.db.execute;
      let resume!: () => void;
      const gate = new Promise<void>((r) => { resume = r; });
      let entered!: () => void;
      const inside = new Promise<void>((r) => { entered = r; });
      ctx.db.execute = async (sql: string, ...args: unknown[]) => {
        if (sql === markWakeAttemptedSql(DB_NAMESPACE)) {
          ctx.db.execute = execute;
          entered();
          await gate;
        }
        return execute(sql, ...args);
      };
      const delivery = deliver("check_run", ciFailed("build"));
      await inside;
      row()!.stale = true;
      return { delivery, resume };
    }

    it("a stalled attempt resumed after the sweep held the row as ambiguous_card never wakes", async () => {
      const { delivery, resume } = await stallBeforeWakeMark();
      laterMentions.push({ body: link(1903), cardId: OTHER, author: DOER }); // ownership becomes ambiguous
      await harness.runJob(SWEEP_JOB_KEY);
      expect(row()!.outcome).toMatch(/^ambiguous_card/);
      resume();
      await delivery;
      expect(hostWakeCalls).toBe(0);
      expect(row()!).toMatchObject({ wakeAttemptedAt: null, commentPostedAt: null });
      expect(row()!.outcome).toMatch(/^ambiguous_card/);
    });

    it("a stalled attempt never acts on a newer row for the same fingerprint (forgotten, then claimed again)", async () => {
      const { delivery, resume } = await stallBeforeWakeMark();
      graph = { mergeable: "MERGEABLE", isDraft: true };
      await harness.runJob(SWEEP_JOB_KEY); // the sweep finds a draft and forgets the never-woken row
      expect(row()).toBeUndefined();
      graph = { mergeable: "MERGEABLE", isDraft: false };
      laterMentions.push({ body: link(1903), cardId: OTHER, author: DOER });
      await deliver("check_run", ciFailed("build")); // a new attempt claims the fingerprint and holds it
      expect(row()!.outcome).toMatch(/^ambiguous_card/);
      resume();
      await delivery;
      expect(hostWakeCalls).toBe(0);
      expect(row()!.outcome).toMatch(/^ambiguous_card/);
    });
  });

  describe("retention never compacts a pending row", () => {
    for (const via of ["the sweep", "a redelivery"] as const) {
      it(`a pending row of a company disabled for 30 days still wakes once via ${via} after re-enabling`, async () => {
        graphFail = true;
        await deliver("check_run", ciFailed("build"));
        expect(row()!.outcome).toBe("error");
        harness.setConfig({ ...baseConfig, enabled: false });
        for (const r of ledger.values()) r.aged = true; // 30 days later
        await harness.runJob(SWEEP_JOB_KEY); // compaction runs for every company
        expect(row()!.signal).not.toBe("{}");
        harness.setConfig(baseConfig);
        graphFail = false;
        if (via === "the sweep") await harness.runJob(SWEEP_JOB_KEY);
        else await deliver("check_run", ciFailed("build"));
        expect(wakes).toHaveLength(1);
      });
    }

    it("a pending row an earlier build compacted is resumed by a genuine redelivery", async () => {
      graphFail = true;
      await deliver("check_run", ciFailed("build"));
      graphFail = false;
      row()!.signal = "{}";
      await deliver("check_run", ciFailed("build"));
      expect(wakes).toHaveLength(1);
    });
  });

  // --- review round 5 (2026-10-27) ---------------------------------------------------------------------------------

  describe("a hold on the card never burns the fingerprint", () => {
    const rerun = { nodeId: "CR_kwDOrun101", startedAt: "2026-10-27T04:05:00Z" };
    const rerunRed: CheckRun = { id: rerun.nodeId, name: "build", status: "COMPLETED", conclusion: "FAILURE", startedAt: rerun.startedAt };
    /** The card blocked by BLOCKER, whose status decides whether the blocker is resolved (harness relations). */
    const blockedBy = (status: string) => harness.seed({
      issues: [issue(BLOCKER, "TOG-1", status), issue(CARD, "TOG-43084", "in_review", { blockedBy: [{ id: BLOCKER, identifier: "TOG-1", status }] })],
    });

    it("after the blocker clears, a genuinely new failing run on the same head wakes once", async () => {
      blockedBy("in_progress");
      await deliver("check_run", ciFailed("build"));
      expect(row()!.outcome).toBe("held_blockers");
      const calls = graphCalls;
      await harness.runJob(SWEEP_JOB_KEY);
      expect(graphCalls).toBe(calls); // a hold is not polled: only a later genuine signal resumes it
      blockedBy("done");
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [rerunRed] };
      await deliver("check_run", ciFailed("build", "failure", HEAD, 1903, rerun));
      expect(wakes).toHaveLength(1);
      expect(row()!.outcome).toMatch(/^woken:/);
      await deliver("check_run", ciFailed("build", "failure", HEAD, 1903, rerun));
      await harness.runJob(SWEEP_JOB_KEY);
      expect(hostWakeCalls).toBe(1);
    });

    it("a later signal while the card is still blocked is held again, without a wake or a comment", async () => {
      blockedBy("in_progress");
      await deliver("check_run", ciFailed("build"));
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [rerunRed] };
      await deliver("check_run", ciFailed("build", "failure", HEAD, 1903, rerun));
      expect(row()!.outcome).toBe("held_blockers");
      expect(wakes).toEqual([]);
      expect(comments).toEqual([]);
    });

    it("a card in blocked status (skipBlockedStatus) wakes on a later genuine signal once it is unblocked", async () => {
      harness.seed({ issues: [issue(CARD, "TOG-43084", "blocked")] });
      await deliver("check_run", reviewFailed());
      expect(row(1903, "review_findings")!.outcome).toBe("held_status:blocked");
      harness.seed({ issues: [issue(CARD, "TOG-43084", "in_progress")] });
      await deliver("check_run", reviewFailed());
      expect(wakes).toHaveLength(1);
    });

    it("a host refusal for blockers (nothing queued) does not stop a later genuine signal once they clear", async () => {
      const ctx = harness.ctx as any;
      const original = ctx.issues.requestWakeup;
      ctx.issues.requestWakeup = vi.fn(async () => {
        hostWakeCalls += 1;
        ctx.issues.requestWakeup = original;
        throw Object.assign(new Error("Issue is blocked by unresolved blockers"), { name: "JsonRpcCallError", code: -32603 });
      });
      await deliver("check_run", ciFailed("build"));
      expect(row()!).toMatchObject({ outcome: "refused:Issue is blocked by unresolved blockers", wakeAttemptedAt: null });
      await harness.runJob(SWEEP_JOB_KEY);
      expect(hostWakeCalls).toBe(1); // not polled
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [rerunRed] };
      await deliver("check_run", ciFailed("build", "failure", HEAD, 1903, rerun));
      expect(wakes).toHaveLength(1);
      expect(hostWakeCalls).toBe(2);
      expect(comments).toEqual([]); // no evidence comments are created
    });
  });

  describe("ready_for_review and reopened do not re-evaluate checks", () => {
    const reasons = () => wakes.map((w) => w.split(":")[1]).sort();

    for (const action of ["ready_for_review", "reopened"]) {
      it(`a check that failed while ${action === "reopened" ? "closed" : "draft"} waits for a new check delivery after ${action}`, async () => {
        graph = action === "reopened" ? { mergeable: "MERGEABLE", isDraft: false, state: "CLOSED" } : { mergeable: "MERGEABLE", isDraft: true };
        await deliver("check_run", ciFailed("build"));
        await deliver("check_run", reviewFailed());
        expect(wakes).toEqual([]);
        expect(ledger.size).toBe(0); // the skip burned nothing
        graph = { mergeable: "MERGEABLE", isDraft: false }; // GitHub still lists the failed build and review on this head
        await deliver("pull_request", prEvent({ action }));
        expect(reasons()).toEqual([]);
        await deliver("pull_request", prEvent({ action })); // redelivered
        await deliver("check_run", ciFailed("build"));
        await deliver("check_run", reviewFailed());
        await harness.runJob(SWEEP_JOB_KEY);
        expect(wakes).toHaveLength(2); // at most once per (PR, head, state)
      });
    }

    it("does not recheck gating checks on ready_for_review", async () => {
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [{ id: "CR_t", name: "test", status: "COMPLETED", conclusion: "TIMED_OUT", startedAt: RUN_STARTED }] };
      await deliver("pull_request", prEvent({ action: "ready_for_review" }));
      expect(reasons()).toEqual([]);
      expect(graphCalls).toBe(0);
    });

    it("a head with nothing red ends at once without a ledger row (never deferred forever)", async () => {
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [{ id: "CR_g", name: "build", status: "COMPLETED", conclusion: "SUCCESS", startedAt: RUN_STARTED }] };
      await deliver("pull_request", prEvent({ action: "ready_for_review" }));
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [] };
      await deliver("pull_request", prEvent({ action: "reopened" }));
      expect(wakes).toEqual([]);
      expect(ledger.size).toBe(0);
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes).toEqual([]);
    });

    it("honours wakeStates and stoppedRepos", async () => {
      await setup({ wakeStates: ["conflict"] });
      await deliver("check_run", ciFailed("build"));
      expect(wakes).toEqual([]);
      await setup({ stoppedRepos: ["togetherweown/two-web-next"] });
      await deliver("check_run", ciFailed("build"));
      expect(wakes).toEqual([]);
      expect(graphCalls).toBe(0);
    });

    it("never wakes a draft, fork or outsider PR, and never after a newer push", async () => {
      for (const current of [
        { mergeable: "MERGEABLE", isDraft: true },
        { mergeable: "MERGEABLE", isDraft: false, cross: true },
        { mergeable: "MERGEABLE", isDraft: false, association: "NONE" },
        { mergeable: "MERGEABLE", isDraft: false, head: HEAD2 },
      ]) {
        graph = current;
        await deliver("check_run", ciFailed("build"));
      }
      expect(graphCalls).toBeGreaterThan(0);
      expect(wakes).toEqual([]);
      expect(ledger.size).toBe(0);
    });

    it("resuming a pending row keeps the delivered run's identity, so GitHub read lag defers instead of forgetting", async () => {
      graphFail = true;
      await deliver("check_run", ciFailed("build"));
      expect(row()!.outcome).toBe("error");
      graphFail = false;
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [] }; // GitHub does not list the delivered run yet
      await harness.runJob(SWEEP_JOB_KEY);
      expect(row()!.outcome).toBe("error"); // kept: the read lags the delivered run
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [redRun()] };
      await harness.runJob(SWEEP_JOB_KEY);
      expect(reasons()).toEqual(["github_pr_ci_red"]);
    });
  });

  describe("check runs keep their suite and are read completely", () => {
    it("a passing run of the same name in an independent check suite never hides a genuine failure", async () => {
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [redRun(), { id: "CR_kwDOother", name: "build", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-27T04:05:00Z", suite: "CS_2" }] };
      await deliver("check_run", ciFailed("build"));
      expect(wakes).toHaveLength(1);
    });

    it("a newer passing run of the same name in the same suite still supersedes the failure", async () => {
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [redRun(), { id: "CR_kwDOrerun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-27T04:05:00Z" }] };
      await deliver("check_run", ciFailed("build"));
      expect(wakes).toEqual([]);
      expect(ledger.size).toBe(0);
    });

    it("the delivered run is found however many suites and runs the head commit has", async () => {
      pageSize = 2;
      const green = (suite: string, n: number): CheckRun[] =>
        Array.from({ length: n }, (_, i) => ({ id: `CR_${suite}_${i}`, name: `lint-${suite}-${i}`, status: "COMPLETED", conclusion: "SUCCESS", startedAt: RUN_STARTED, suite }));
      graph = { mergeable: "MERGEABLE", isDraft: false, checks: [...green("CS_1", 2), ...green("CS_2", 2), ...green("CS_3", 3), { ...redRun(), suite: "CS_3" }] };
      await deliver("check_run", ciFailed("build"));
      expect(wakes).toHaveLength(1);
      expect(ledger.size).toBe(1);
    });
  });
});
