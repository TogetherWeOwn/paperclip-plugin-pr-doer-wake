import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { parseConfig, validateConfig } from "../src/config.js";
import plugin from "../src/plugin.js";
import { DB_NAMESPACE, SWEEP_JOB_KEY } from "../src/constants.js";
import {
  CARD_BY_COMMENT_SQL,
  CARD_BY_IDENTIFIER_SQL,
  COMMENT_EXISTS_SQL,
  claimSql,
  markCommentPostedSql,
  markWakeAttemptedSql,
  pruneSql,
  recordOutcomeSql,
  retryableSql,
  seenSql,
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
  commentPostedAt: string | null; wakeAttemptedAt: string | null; stale?: boolean;
};
type Graph = { mergeable: string; isDraft: boolean; state?: string; head?: string; cross?: boolean; association?: string; login?: string; ref?: string; updatedAt?: string };

let harness: TestHarness;
let ledger: Map<string, LedgerRow>;
let commentCards: Map<string, string>; // PR regex -> card id (the comment-search result)
let wakes: string[];
let comments: Array<{ issueId: string; body: string }>;
let graph: Graph | null;
let graphFail: boolean;
let graphCalls: number;
let failNext: Set<string>; // one-shot injected failures: "comment", "markComment"
let hostWakeCalls: number; // requestWakeup calls that reached the host, whatever the reply

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
    name: "Paperclip Review", conclusion: "failure", head_sha: head, html_url: "https://github.com/TogetherWeOwn/two-web-next/runs/9",
    output: { title: "3/5" }, pull_requests: [{ number: 1903, head: { sha: head, ref }, base: { ref: "main" } }],
  },
});

const ciFailed = (name: string, conclusion = "failure", head = HEAD, number = 1903) => ({
  action: "completed",
  check_run: { name, conclusion, head_sha: head, html_url: "https://github.com/x/runs/2", output: {}, pull_requests: [{ number, head: { sha: head, ref: "feat/quality" }, base: { ref: "main" } }] },
});
const row = (number = 1903, state = "ci_red", head = HEAD) => ledger.get(`${CID}|togetherweown/two-web-next#${number}@${head}:${state}`);

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
    issues: [issue(CARD, "TOG-43084", "in_review"), issue(BLOCKER, "TOG-1", "in_progress"), issue(OTHER, "TOG-777", "in_progress")],
  });
  ledger = new Map();
  commentCards = new Map([["github\\.com/togetherweown/two-web-next/pull/1903([^0-9]|$)", CARD]]);
  wakes = [];
  comments = [];
  graph = { mergeable: "MERGEABLE", isDraft: false }; // what GitHub currently says about PR 1903
  graphFail = false;
  graphCalls = 0;
  failNext = new Set();
  hostWakeCalls = 0;
  const ctx = harness.ctx as any;
  ctx.secrets.resolve = async (ref: { secretId: string }) => (ref.secretId.endsWith("1") ? SECRET : "gh-token");
  // In-memory stand-in for the plugin namespace + the whitelisted core reads.
  ctx.db.namespace = DB_NAMESPACE;
  ctx.db.execute = async (sql: string, params: unknown[] = []) => {
    const key = `${params[0]}|${params[1]}`;
    if (sql === claimSql(DB_NAMESPACE)) {
      if (ledger.has(key)) return { rowCount: 0 };
      ledger.set(key, { outcome: "claimed", issueId: null, attempts: 0, signal: String(params[6]), commentPostedAt: null, wakeAttemptedAt: null });
      return { rowCount: 1 };
    }
    if (sql === recordOutcomeSql(DB_NAMESPACE)) {
      const row = ledger.get(key)!;
      Object.assign(row, { outcome: params[2], issueId: params[3], attempts: row.attempts + 1 });
      return { rowCount: 1 };
    }
    if (sql === markCommentPostedSql(DB_NAMESPACE)) {
      if (failNext.delete("markComment")) throw new Error("db connection reset");
      Object.assign(ledger.get(key)!, { commentPostedAt: new Date().toISOString(), issueId: params[2] });
      return { rowCount: 1 };
    }
    if (sql === markWakeAttemptedSql(DB_NAMESPACE)) {
      Object.assign(ledger.get(key)!, { wakeAttemptedAt: new Date().toISOString(), issueId: params[2] });
      return { rowCount: 1 };
    }
    if (sql === pruneSql(DB_NAMESPACE)) return { rowCount: 0 };
    throw new Error(`unexpected execute ${sql}`);
  };
  ctx.db.query = async (sql: string, params: unknown[] = []) => {
    const exclude = String(params[params.length - 1] ?? "").split(",");
    const issues = [...[CARD, BLOCKER, OTHER].map((id) => harness.ctx.issues.get(id, CID))];
    const rows = (await Promise.all(issues)).filter(Boolean) as any[];
    const live = rows.filter((r) => !["done", "cancelled"].includes(r.status) && !exclude.includes(r.assigneeAgentId));
    if (sql === CARD_BY_IDENTIFIER_SQL) return live.filter((r) => r.identifier === params[1]);
    if (sql === CARD_BY_COMMENT_SQL) return live.filter((r) => commentCards.get(String(params[2])) === r.id);
    if (sql === seenSql(DB_NAMESPACE)) return ledger.has(`${params[0]}|${params[1]}`) ? [{ fingerprint: params[1] }] : [];
    if (sql === COMMENT_EXISTS_SQL) return comments.filter((c) => c.issueId === params[1] && c.body === params[2]).map(() => ({ id: "c" }));
    if (sql === retryableSql(DB_NAMESPACE)) {
      return [...ledger.entries()]
        .filter(([, r]) => (["error", "no_card"].includes(r.outcome) || (r.outcome === "claimed" && r.stale)) && r.attempts < 5) // time windows: see sql.test
        .map(([k, r]) => ({ fingerprint: k.split("|")[1], signal: r.signal, issue_id: r.issueId, comment_posted_at: r.commentPostedAt, wake_attempted_at: r.wakeAttemptedAt }));
    }
    throw new Error(`unexpected query ${sql}`);
  };
  ctx.http.fetch = async (_url: string, init?: { body?: string }) => {
    graphCalls += 1;
    if (graphFail) return new Response("bad gateway", { status: 502 });
    const n = Number(JSON.parse(init?.body ?? "{}").variables?.n ?? 1903);
    const nodes = graph ? [{
      number: n, url: `https://github.com/TogetherWeOwn/two-web-next/pull/${n}`, state: graph.state ?? "OPEN", isDraft: graph.isDraft,
      isCrossRepository: graph.cross ?? false, authorAssociation: graph.association ?? "MEMBER", author: { login: graph.login ?? "doer" },
      headRefOid: graph.head ?? HEAD, headRefName: graph.ref ?? "feat/quality", baseRefName: "main", mergeable: graph.mergeable, updatedAt: graph.updatedAt ?? new Date().toISOString(),
    }] : [];
    return new Response(JSON.stringify({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes }, pullRequest: nodes[0] ?? null } } }), { status: 200 });
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
    if (failNext.delete("comment")) throw new Error("worker RPC timeout");
    comments.push({ issueId, body });
    return realComment(issueId, body, companyId, opts);
  };
  return plugin.definition.setup(harness.ctx);
}

describe("pr-doer-wake end to end (SDK test harness)", () => {
  beforeEach(async () => {
    await setup();
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
    commentCards.set("github\\.com/togetherweown/two-web-next/pull/1904([^0-9]|$)", CARD);
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
    failNext.add("comment"); // transient failure after the card was chosen, before any wake
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
    commentCards.set("github\\.com/togetherweown/two-web-next/pull/1903([^0-9]|$)", CARD); // the doer posts the PR URL
    await deliver("check_run", ciFailed("build")); // redelivery: already claimed
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes).toHaveLength(1);
    expect(row()!.outcome).toMatch(/^woken:/);
  });

  it("holds the wake when the branch and the PR-link comment name different cards", async () => {
    commentCards.set("github\\.com/togetherweown/two-web-next/pull/1903([^0-9]|$)", OTHER);
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
    graph = { mergeable: "MERGEABLE", isDraft: false };
    await deliver("pull_request", prEvent({ action: "ready_for_review" }));
    await deliver("check_run", ciFailed("build"));
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
      commentCards.set("github\\.com/togetherweown/two-web-next/pull/1903([^0-9]|$)", CARD);
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

  it("a requestWakeup error is never retried: without a host receipt a second request could double-wake", async () => {
    const ctx = harness.ctx as any;
    const original = ctx.issues.requestWakeup;
    ctx.issues.requestWakeup = vi.fn(async () => { throw new Error("worker RPC timeout"); });
    await deliver("check_run", reviewFailed());
    expect([...ledger.values()][0]!.outcome).toBe("wake_unconfirmed");
    ctx.issues.requestWakeup = original;
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes).toEqual([]);
    expect(comments).toHaveLength(1);
  });

  async function failFirstWake() {
    failNext.add("comment"); // fails before any wake was requested: retryable
    await deliver("pull_request", prEvent());
    await deliver("check_run", reviewFailed());
    expect([...ledger.values()][0]!.outcome).toBe("error");
  }

  for (const [label, current, outcome] of [
    ["turned draft", { mergeable: "MERGEABLE", isDraft: true }, "stale:skipped_draft"],
    ["was closed", { mergeable: "MERGEABLE", isDraft: false, state: "CLOSED" }, "stale:skipped_closed"],
    ["was merged", { mergeable: "MERGEABLE", isDraft: false, state: "MERGED" }, "stale:skipped_closed"],
    ["got a new head", { mergeable: "MERGEABLE", isDraft: false, head: HEAD2 }, "stale:stale_head"],
  ] as const) {
    it(`a sweep retry re-reads the PR and never wakes one that ${label}`, async () => {
      await failFirstWake();
      graph = { ...current };
      await harness.runJob(SWEEP_JOB_KEY);
      expect(wakes).toEqual([]);
      expect([...ledger.values()][0]!.outcome).toBe(outcome);
      await harness.runJob(SWEEP_JOB_KEY); // terminal: not retried again
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
    expect(comments).toHaveLength(1);
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

  it("the conflict sweep ignores fork PRs", async () => {
    await deliver("push", { ref: "refs/heads/main" });
    graph = { mergeable: "CONFLICTING", isDraft: false, cross: true };
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes).toEqual([]);
  });

  it("a row stuck at 'claimed' after the wake was requested (worker died mid-call) is not requested again", async () => {
    const signal = { repo: "togetherweown/two-web-next", number: 1903, head: HEAD, state: "ci_red", url: "u", headRef: "feat/quality", draft: false, trusted: true, detail: {} };
    ledger.set(`${CID}|togetherweown/two-web-next#1903@${HEAD}:ci_red`, { outcome: "claimed", issueId: CARD, attempts: 0, signal: JSON.stringify(signal), commentPostedAt: new Date().toISOString(), wakeAttemptedAt: new Date().toISOString(), stale: true });
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes).toEqual([]);
    expect(graphCalls).toBe(0);
    expect(row()!.outcome).toBe("wake_unconfirmed");
  });

  it("recovers a ledger row stuck at 'claimed' (worker died between claim and outcome)", async () => {
    const signal = { repo: "togetherweown/two-web-next", number: 1903, head: HEAD, state: "ci_red", url: "https://github.com/TogetherWeOwn/two-web-next/pull/1903", headRef: "feat/quality", draft: false, trusted: true, detail: { checkName: "build", checkUrl: "u", conclusion: "failure" } };
    ledger.set(`${CID}|togetherweown/two-web-next#1903@${HEAD}:ci_red`, { outcome: "claimed", issueId: null, attempts: 0, signal: JSON.stringify(signal), commentPostedAt: null, wakeAttemptedAt: null, stale: true });
    graph = { mergeable: "MERGEABLE", isDraft: false };
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes).toHaveLength(1);
    expect(comments).toHaveLength(1);
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
    await deliver("check_run", ciFailed("build"));
    expect([...ledger.values()].map((r) => r.outcome)).toEqual(["error"]);
    ctx.secrets.resolve = resolve;
    graph = { mergeable: "MERGEABLE", isDraft: false };
    await harness.runJob(SWEEP_JOB_KEY);
    expect(wakes).toHaveLength(1);
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

  it("a redelivered red check costs no further GitHub lookup", async () => {
    await deliver("check_run", ciFailed("build"));
    await deliver("check_run", ciFailed("build"));
    await deliver("check_run", ciFailed("test"));
    expect(wakes).toHaveLength(1);
    expect(graphCalls).toBe(1);
  });

  it("a retry posts the evidence comment that the first attempt never posted", async () => {
    failNext.add("comment");
    await deliver("pull_request", prEvent());
    await deliver("check_run", reviewFailed());
    expect(comments).toEqual([]);
    expect(wakes).toEqual([]);
    graph = { mergeable: "MERGEABLE", isDraft: false };
    await harness.runJob(SWEEP_JOB_KEY);
    expect(comments).toHaveLength(1);
    expect(wakes).toHaveLength(1);
  });

  it("a retry does not repeat a comment that was posted when only the phase mark was lost", async () => {
    failNext.add("markComment");
    await deliver("pull_request", prEvent());
    await deliver("check_run", reviewFailed());
    expect(comments).toHaveLength(1);
    expect(wakes).toEqual([]);
    graph = { mergeable: "MERGEABLE", isDraft: false };
    await harness.runJob(SWEEP_JOB_KEY);
    expect(comments).toHaveLength(1);
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

  it("the conflict sweep continues past the page cap on the next tick via the saved cursor", async () => {
    await setup({ sweepMaxPages: 2 });
    const ctx = harness.ctx as any;
    const cursors: Array<string | null> = [];
    ctx.http.fetch = async (_url: string, init: { body: string }) => {
      const { variables } = JSON.parse(init.body);
      cursors.push(variables.cursor);
      const page = cursors.length;
      const node = { number: page, url: `https://github.com/TogetherWeOwn/two-web-next/pull/${page}`, state: "OPEN", isDraft: false, isCrossRepository: false, authorAssociation: "MEMBER", author: { login: "doer" }, headRefOid: HEAD, headRefName: "x", baseRefName: "main", mergeable: "MERGEABLE", updatedAt: new Date().toISOString() };
      return new Response(JSON.stringify({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: page < 3, endCursor: `c${page}` }, nodes: [node] } } } }), { status: 200 });
    };
    await deliver("push", { ref: "refs/heads/main" });
    await harness.runJob(SWEEP_JOB_KEY);
    expect(cursors).toEqual([null, "c1"]);
    await harness.runJob(SWEEP_JOB_KEY);
    expect(cursors).toEqual([null, "c1", "c2"]);
    await harness.runJob(SWEEP_JOB_KEY); // finished: nothing left to read
    expect(cursors).toHaveLength(3);
  });
});
