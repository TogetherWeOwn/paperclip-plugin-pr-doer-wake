import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/plugin.js";
import { DB_NAMESPACE, SWEEP_JOB_KEY } from "../src/constants.js";
import { CARD_BY_COMMENT_SQL, CARD_BY_IDENTIFIER_SQL, claimSql, pruneSql, recordOutcomeSql, retryableSql } from "../src/sql.js";

const CID = "ef993a7e-5ea7-445f-ba88-27a6a2690c3a";
const DOER = "11111111-1111-4111-8111-111111111111";
const REVIEWER = "68cba6b5-f816-4853-a3db-4389cd9ae8ca";
const CARD = "aaaaaaaa-0000-4000-8000-000000000001";
const BLOCKER = "aaaaaaaa-0000-4000-8000-000000000002";
const SECRET = "whsec-test";
const HEAD = "c05b0b5d" + "0".repeat(32);
const HEAD2 = "d15ea5e0" + "0".repeat(32);
const repository = { full_name: "TogetherWeOwn/two-web-next", default_branch: "main", owner: { login: "TogetherWeOwn" } };
const organization = { login: "TogetherWeOwn" };

type LedgerRow = { outcome: string; issueId: string | null; attempts: number; signal: string };

let harness: TestHarness;
let ledger: Map<string, LedgerRow>;
let commentCards: Map<string, string>; // PR regex -> card id (the comment-search result)
let wakes: string[];
let comments: Array<{ issueId: string; body: string }>;
let graph: { mergeable: string; isDraft: boolean } | null;
let graphCalls: number;

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

const prEvent = (opts: { head?: string; draft?: boolean; ref?: string; action?: string; extra?: Record<string, unknown> } = {}) => ({
  action: opts.action ?? "synchronize",
  pull_request: {
    number: 1903, state: "open", draft: opts.draft ?? false, html_url: "https://github.com/TogetherWeOwn/two-web-next/pull/1903",
    head: { sha: opts.head ?? HEAD, ref: opts.ref ?? "feat/quality" }, base: { ref: "main" }, ...(opts.extra ?? {}),
  },
});

const reviewFailed = (head = HEAD, ref = "feat/quality") => ({
  action: "completed",
  check_run: {
    name: "Paperclip Review", conclusion: "failure", head_sha: head, html_url: "https://github.com/TogetherWeOwn/two-web-next/runs/9",
    output: { title: "3/5" }, pull_requests: [{ number: 1903, head: { sha: head, ref }, base: { ref: "main" } }],
  },
});

const ciFailed = (name: string, conclusion = "failure", head = HEAD) => ({
  action: "completed",
  check_run: { name, conclusion, head_sha: head, html_url: "https://github.com/x/runs/2", output: {}, pull_requests: [{ number: 1903, head: { sha: head, ref: "feat/quality" }, base: { ref: "main" } }] },
});

function setup(config: Record<string, unknown> = {}) {
  harness = createTestHarness({
    manifest,
    config: {
      enabled: true, shadow: false, githubOrg: "TogetherWeOwn",
      webhookSecretRef: { type: "secret_ref", secretId: "00000000-0000-4000-8000-000000000001" },
      githubTokenSecretRef: { type: "secret_ref", secretId: "00000000-0000-4000-8000-000000000002" },
      excludeAgentIds: [REVIEWER], ...config,
    },
  });
  harness.seed({
    companies: [{ id: CID, name: "TogetherWeOwn" } as any],
    issues: [issue(CARD, "TOG-43084", "in_review"), issue(BLOCKER, "TOG-1", "in_progress")],
  });
  ledger = new Map();
  commentCards = new Map([["github\\.com/togetherweown/two-web-next/pull/1903([^0-9]|$)", CARD]]);
  wakes = [];
  comments = [];
  graph = null;
  graphCalls = 0;
  const ctx = harness.ctx as any;
  ctx.secrets.resolve = async (ref: { secretId: string }) => (ref.secretId.endsWith("1") ? SECRET : "gh-token");
  // In-memory stand-in for the plugin namespace + the two whitelisted core reads.
  ctx.db.namespace = DB_NAMESPACE;
  ctx.db.execute = async (sql: string, params: unknown[] = []) => {
    const key = `${params[0]}|${params[1]}`;
    if (sql === claimSql(DB_NAMESPACE)) {
      if (ledger.has(key)) return { rowCount: 0 };
      ledger.set(key, { outcome: "claimed", issueId: null, attempts: 0, signal: String(params[6]) });
      return { rowCount: 1 };
    }
    if (sql === recordOutcomeSql(DB_NAMESPACE)) {
      const row = ledger.get(key)!;
      Object.assign(row, { outcome: params[2], issueId: params[3], attempts: row.attempts + 1 });
      return { rowCount: 1 };
    }
    if (sql === pruneSql(DB_NAMESPACE)) return { rowCount: 0 };
    throw new Error(`unexpected execute ${sql}`);
  };
  ctx.db.query = async (sql: string, params: unknown[] = []) => {
    const exclude = String(params[params.length - 1] ?? "").split(",");
    const issues = [...[CARD, BLOCKER].map((id) => harness.ctx.issues.get(id, CID))];
    const rows = (await Promise.all(issues)).filter(Boolean) as any[];
    const live = rows.filter((r) => !["done", "cancelled"].includes(r.status) && !exclude.includes(r.assigneeAgentId));
    if (sql === CARD_BY_IDENTIFIER_SQL) return live.filter((r) => r.identifier === params[1]);
    if (sql === CARD_BY_COMMENT_SQL) return live.filter((r) => commentCards.get(String(params[2])) === r.id);
    if (sql === retryableSql(DB_NAMESPACE)) {
      return [...ledger.entries()].filter(([, r]) => r.outcome === "error" && r.attempts < 3).map(([k, r]) => ({ fingerprint: k.split("|")[1], signal: r.signal }));
    }
    throw new Error(`unexpected query ${sql}`);
  };
  ctx.http.fetch = async () => {
    graphCalls += 1;
    const nodes = graph ? [{ number: 1903, url: "https://github.com/TogetherWeOwn/two-web-next/pull/1903", isDraft: graph.isDraft, headRefOid: HEAD, headRefName: "feat/quality", baseRefName: "main", mergeable: graph.mergeable }] : [];
    return new Response(JSON.stringify({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes }, pullRequest: nodes[0] ?? null } } }), { status: 200 });
  };
  const realWake = ctx.issues.requestWakeup.bind(ctx.issues);
  ctx.issues.requestWakeup = vi.fn(async (issueId: string, companyId: string, options: any) => {
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

  it("wakes the owning card once with evidence when Paperclip Review fails", async () => {
    await deliver("pull_request", prEvent());
    await deliver("check_run", reviewFailed());
    expect(wakes).toEqual([`${CARD}:github_pr_review_findings:pr-doer-wake:togetherweown/two-web-next#1903@${HEAD}:review_findings`]);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("Paperclip Review scored 3/5");
    expect(ledger.get(`${CID}|togetherweown/two-web-next#1903@${HEAD}:review_findings`)!.outcome).toMatch(/^woken:/);
  });

  it("dedupes redeliveries and further failing checks on the same head; a new head wakes again", async () => {
    await deliver("pull_request", prEvent());
    await deliver("check_run", ciFailed("build"));
    await deliver("check_run", ciFailed("build"));
    await deliver("check_run", ciFailed("test"));
    expect(wakes).toHaveLength(1);
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
    await deliver("pull_request", prEvent({ draft: true, action: "opened" }));
    await deliver("check_run", ciFailed("build"));
    await deliver("check_run", reviewFailed());
    expect(wakes).toEqual([]);
    expect(ledger.size).toBe(0);
  });

  it("looks up an unseen PR once to learn its draft flag", async () => {
    graph = { mergeable: "MERGEABLE", isDraft: true };
    await deliver("check_run", ciFailed("build"));
    expect(graphCalls).toBe(1);
    expect(wakes).toEqual([]);
    graph = { mergeable: "MERGEABLE", isDraft: false };
    await deliver("pull_request", prEvent({ action: "ready_for_review" }));
    await deliver("check_run", ciFailed("build"));
    expect(wakes).toHaveLength(1);
  });

  it("skips unseen PRs when no token is configured (draft unknown)", async () => {
    await setup({ githubTokenSecretRef: undefined });
    await deliver("check_run", ciFailed("build"));
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
      commentCards.set("github\\.com/togetherweown/two-web-next/pull/1903([^0-9]|$)", CARD);
      await deliver("pull_request", prEvent());
      await deliver("check_run", reviewFailed());
      expect(wakes).toEqual([]);
    }
  });

  it("prefers the card named by the head branch and never picks an excluded agent's card", async () => {
    commentCards.clear();
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

  it("wakes on merge", async () => {
    await deliver("pull_request", prEvent({ action: "closed", extra: { state: "closed", merged: true } }));
    expect(wakes.map((w) => w.split(":")[1])).toEqual(["github_pr_merged"]);
    expect(comments[0]!.body).toContain("was merged");
  });

  it("shadow mode records and logs but posts and wakes nothing", async () => {
    await setup({ shadow: true });
    await deliver("pull_request", prEvent());
    await deliver("check_run", reviewFailed());
    expect(wakes).toEqual([]);
    expect(comments).toEqual([]);
    expect([...ledger.values()][0]!.outcome).toBe("shadow:TOG-43084");
  });

  it("conflict sweep: a push to main marks the repo; the job wakes owners of conflicting non-draft PRs once", async () => {
    await deliver("pull_request", prEvent());
    await deliver("push", { ref: "refs/heads/main" });
    graph = { mergeable: "UNKNOWN", isDraft: false };
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes).toEqual([]);
    graph = { mergeable: "CONFLICTING", isDraft: false };
    await harness.runJob(SWEEP_JOB_KEY); // repo stayed marked because mergeability was UNKNOWN
    expect(wakes.map((w) => w.split(":")[1])).toEqual(["github_pr_conflict"]);
    await deliver("push", { ref: "refs/heads/main" });
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes).toHaveLength(1); // same head, same state: exactly once
    const calls = graphCalls;
    await harness.runJob(SWEEP_JOB_KEY); // nothing marked: no GitHub call
    expect(graphCalls).toBe(calls);
  });

  it("conflict sweep ignores draft PRs", async () => {
    await deliver("push", { ref: "refs/heads/main" });
    graph = { mergeable: "CONFLICTING", isDraft: true };
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes).toEqual([]);
  });

  it("retries a transient wake failure from the sweep job without a second comment", async () => {
    const ctx = harness.ctx as any;
    const original = ctx.issues.requestWakeup;
    ctx.issues.requestWakeup = vi.fn(async () => { throw new Error("worker RPC timeout"); });
    await deliver("pull_request", prEvent());
    await deliver("check_run", reviewFailed());
    expect([...ledger.values()][0]!.outcome).toBe("error");
    ctx.issues.requestWakeup = original;
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes).toHaveLength(1);
    expect(comments).toHaveLength(1);
    expect([...ledger.values()][0]!.outcome).toMatch(/^woken:/);
  });
});
