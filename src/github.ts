import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeLogin, type DoerWakeConfig } from "./config.js";
import type { WakeState } from "./constants.js";

/**
 * The PR as GitHub reports it right now (GraphQL). The only authority for open/draft/head/trust: webhook payloads
 * can arrive late, out of order or with tied updated_at values, so they never decide whether a PR may wake.
 */
export interface PrState {
  repo: string; // lowercase "org/repo"
  number: number;
  head: string;
  headRef: string | null;
  draft: boolean;
  url: string;
  open: boolean;
  /** Head branch in the base repo and a trusted author; see isTrustedAuthor. */
  trusted: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /**
   * Runs of the signal's check on the PR's head commit as GitHub reports them now (LATEST per check suite).
   * Undefined when not read (conflict signals); a check signal without it never wakes.
   */
  checkRuns?: CheckRunState[];
}

export interface CheckRunState {
  /** GraphQL node id, the same value as the webhook's check_run.node_id. */
  id: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
}

export interface Signal {
  repo: string;
  number: number;
  head: string;
  state: WakeState;
  url: string;
  headRef: string | null;
  /** Set from the authoritative PR state (evaluate); null until then, and a null never wakes. */
  draft: boolean | null;
  /** Set from the authoritative PR state (evaluate); null until then, and a null never wakes. */
  trusted: boolean | null;
  detail: {
    score?: number | null;
    checkName?: string;
    checkUrl?: string;
    conclusion?: string;
    /** check_run.node_id of the delivered run: revalidation compares it with GitHub's current runs. */
    checkRunId?: string;
    /** check_run.started_at of the delivered run: tells a lagging GitHub read from a newer run. */
    checkStartedAt?: string | null;
  };
}

export interface ParsedEvent {
  signals: Signal[];
  /** Repos whose default branch moved: open PRs may now conflict. */
  sweepRepos: string[];
}

/**
 * The only GitHub events this plugin consumes. Subscribe the org webhook to exactly these: the host stores every
 * delivery in plugin_webhook_deliveries and never prunes it (README "Webhook events").
 */
export const SUBSCRIBED_EVENTS = new Set(["pull_request", "check_run", "push"]);

/** Shape of GitHub's X-Hub-Signature-256 header; anything else is rejected before any company or secret work. */
export const SIGNATURE_RE = /^sha256=[0-9a-f]{64}$/;

/** author_association values trusted to name a card by branch (GitHub REST/GraphQL CommentAuthorAssociation). */
export const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** Conclusions that mean the check really failed. cancelled/stale/skipped/neutral/action_required never wake. */
export const RED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);
/** The only Paperclip Review conclusion that is a finding (see parseEvent). */
export const REVIEW_RED_CONCLUSIONS = new Set(["failure"]);

/** pull_request actions whose payload may already report a merge conflict (`mergeable_state: dirty`). */
export const CONFLICT_PR_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review", "edited"]);

/**
 * Cheap pre-filter run BEFORE signature verification. Most org deliveries (check_run created/success,
 * pull_request labeled/assigned, feature-branch pushes) can never act, so they are acknowledged without loading
 * company config or touching a secret. Skipping an unverified event is safe: it performs no work. Deliveries that
 * pass still verify against the worker-memory secret cache (src/secrets.ts) before any per-company work.
 */
export function mayAct(eventName: string, payload: Json): boolean {
  switch (eventName) {
    case "pull_request":
      return CONFLICT_PR_ACTIONS.has(String(payload?.action ?? "")) && isDirtyOpenPr(payload?.pull_request);
    case "check_run":
      return payload?.action === "completed" && RED_CONCLUSIONS.has(String(payload?.check_run?.conclusion ?? ""));
    case "push": {
      const defaultBranch = payload?.repository?.default_branch;
      return typeof defaultBranch === "string" && payload?.ref === `refs/heads/${defaultBranch}` && payload?.deleted !== true;
    }
    default:
      return false;
  }
}

export function verifySignature(secret: string, rawBody: string, header: string | undefined): boolean {
  if (!secret || !header || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function fingerprint(signal: Pick<Signal, "repo" | "number" | "head" | "state">): string {
  return `${signal.repo.toLowerCase()}#${signal.number}@${signal.head}:${signal.state}`;
}

function empty(): ParsedEvent {
  return { signals: [], sweepRepos: [] };
}

function isDirtyOpenPr(pr: Json | undefined): boolean {
  return pr?.state === "open" && pr?.draft !== true && pr?.mergeable_state === "dirty";
}

/** OWNER/MEMBER/COLLABORATOR, or a login listed in trustedAuthors (bots report NONE). */
export function isTrustedAuthor(config: DoerWakeConfig, association: unknown, login: unknown): boolean {
  if (typeof association === "string" && TRUSTED_ASSOCIATIONS.has(association.toUpperCase())) return true;
  return typeof login === "string" && config.trustedAuthors.includes(normalizeLogin(login));
}

export type SkipOutcome =
  | "skipped_closed"
  | "stale_head"
  | "untrusted"
  | "skipped_draft"
  | "draft_unknown"
  | "not_conflicting"
  | "check_not_red"
  | "stopped_repo";

export type PrCheck =
  | { kind: "ok"; signal: Signal }
  | { kind: "skip"; outcome: SkipOutcome; detail?: string }
  | { kind: "transient"; detail: string };

/** Repo policy every path re-applies right before any effect: the config may have changed since the signal arrived. */
export function policySkip(config: DoerWakeConfig, signal: Pick<Signal, "repo" | "state">): "stopped_repo" | "skipped_state" | null {
  if (config.stoppedRepos.includes(signal.repo.toLowerCase())) return "stopped_repo";
  if (!config.wakeStates.includes(signal.state)) return "skipped_state";
  return null;
}

function startedMs(run: CheckRunState): number {
  // A queued run has not started yet: it is the newest.
  if (!run.startedAt) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(run.startedAt);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * Is the signal's check still red on this head? Webhooks arrive late and out of order and checks are re-run on the
 * same head, so the delivered conclusion alone never wakes: GitHub's newest run of that check name must be completed
 * and red. A newer passing, re-running or updated-to-passing run is stale; GitHub not listing the delivered run yet
 * (its read lags the webhook) is transient.
 */
export function checkVerdict(runs: CheckRunState[] | undefined, signal: Signal): PrCheck | null {
  if (!runs) return { kind: "transient", detail: "check runs not read" };
  if (runs.length === 0) return { kind: "transient", detail: `no ${signal.detail.checkName ?? "check"} run visible on the head yet` };
  const red = signal.state === "review_findings" ? REVIEW_RED_CONCLUSIONS : RED_CONCLUSIONS;
  const latest = runs.reduce((a, b) => (startedMs(b) > startedMs(a) ? b : a));
  if (latest.status === "COMPLETED" && red.has(String(latest.conclusion ?? "").toLowerCase())) return null; // still red
  const delivered = signal.detail.checkRunId ? runs.find((r) => r.id === signal.detail.checkRunId) : undefined;
  const deliveredStart = signal.detail.checkStartedAt ? Date.parse(signal.detail.checkStartedAt) : Number.NaN;
  if (!delivered && !Number.isNaN(deliveredStart) && startedMs(latest) < deliveredStart) {
    return { kind: "transient", detail: "GitHub does not list the failing run yet" };
  }
  const detail = latest.status === "COMPLETED" ? `latest run ${String(latest.conclusion).toLowerCase()}` : `latest run ${latest.status.toLowerCase()}`;
  return { kind: "skip", outcome: "check_not_red", detail };
}

/**
 * May this signal wake, given the PR as GitHub reports it now? Closed, merged, re-pushed, untrusted and draft PRs
 * never do; nor does a check signal whose check is no longer red, or a conflict GitHub no longer reports.
 */
export function evaluate(pr: PrState, signal: Signal): PrCheck {
  if (!pr.open) return { kind: "skip", outcome: "skipped_closed" };
  if (pr.head !== signal.head) return { kind: "skip", outcome: "stale_head", detail: pr.head };
  if (!pr.trusted) return { kind: "skip", outcome: "untrusted" };
  if (pr.draft) return { kind: "skip", outcome: "skipped_draft" };
  if (signal.state === "conflict") {
    if (pr.mergeable !== "CONFLICTING") {
      // GitHub computes mergeability lazily: UNKNOWN is read again by the sweep.
      return pr.mergeable === "UNKNOWN" ? { kind: "transient", detail: "mergeability not computed yet" } : { kind: "skip", outcome: "not_conflicting" };
    }
  } else {
    const verdict = checkVerdict(pr.checkRuns, signal);
    if (verdict) return verdict;
  }
  return { kind: "ok", signal: { ...signal, draft: false, trusted: true, headRef: pr.headRef ?? signal.headRef } };
}

type Json = Record<string, any>;

export function repoOf(payload: Json): string | null {
  const name = payload?.repository?.full_name;
  return typeof name === "string" ? name.toLowerCase() : null;
}

export function ownerOf(payload: Json): string | null {
  const login = payload?.organization?.login ?? payload?.repository?.owner?.login;
  return typeof login === "string" ? login : null;
}

/** A check name gates the PR when it is not ignored and, if the repo lists required checks, is one of them. */
export function isGatingCheck(config: DoerWakeConfig, repo: string, name: string): boolean {
  if (config.ignoreChecks.includes(name)) return false;
  const required = config.requiredChecks[repo];
  return !required || required.length === 0 || required.includes(name);
}

/** Score from the Paperclip Review check title (`3/5`), set in chat-github-reviews.ts ~line 1307. */
export function reviewScore(title: unknown): number | null {
  if (typeof title !== "string") return null;
  const match = /^(\d+)\/5$/.exec(title.trim());
  return match ? Number(match[1]) : null;
}

export function parseEvent(eventName: string, payload: Json, config: DoerWakeConfig): ParsedEvent {
  const out = empty();
  const repo = repoOf(payload);
  if (!repo || config.stoppedRepos.includes(repo)) return out;

  if (eventName === "pull_request") {
    // Only a payload that already reports a conflict is a candidate; the authoritative lookup decides the rest.
    const pr = payload.pull_request as Json | undefined;
    if (!pr || typeof pr.number !== "number" || !CONFLICT_PR_ACTIONS.has(String(payload.action)) || !isDirtyOpenPr(pr)) return out;
    out.signals.push({
      repo,
      number: pr.number,
      head: String(pr.head?.sha ?? ""),
      state: "conflict",
      url: String(pr.html_url ?? `https://github.com/${payload.repository.full_name}/pull/${pr.number}`),
      headRef: typeof pr.head?.ref === "string" ? pr.head.ref : null,
      draft: null,
      trusted: null,
      detail: {},
    });
    return out;
  }

  if (eventName === "check_run") {
    const run = payload.check_run as Json | undefined;
    if (!run || payload.action !== "completed") return out;
    const name = String(run.name ?? "");
    const conclusion = String(run.conclusion ?? "");
    const isReview = name === config.reviewCheckName;
    let state: WakeState | null = null;
    let score: number | null = null;
    if (isReview) {
      // githubReviewConclusion (chat-github-review-policy.ts:229): "failure" only for a complete
      // assessment below ratingThreshold. action_required = admission refusal/incomplete: never a finding.
      if (conclusion === "failure") {
        state = "review_findings";
        score = reviewScore(run.output?.title);
      }
    } else if (RED_CONCLUSIONS.has(conclusion) && isGatingCheck(config, repo, name)) {
      state = "ci_red";
    }
    if (!state) return out;
    for (const pr of (run.pull_requests ?? []) as Json[]) {
      if (typeof pr.number !== "number") continue;
      const head = String(pr.head?.sha ?? "");
      if (!head || head !== run.head_sha) continue; // superseded head: the newer head gets its own checks
      out.signals.push({
        repo,
        number: pr.number,
        head,
        state,
        url: `https://github.com/${payload.repository.full_name}/pull/${pr.number}`,
        headRef: typeof pr.head?.ref === "string" ? pr.head.ref : null,
        draft: null,
        trusted: null,
        detail: {
          score,
          checkName: name,
          checkUrl: String(run.html_url ?? run.details_url ?? ""),
          conclusion,
          ...(typeof run.node_id === "string" ? { checkRunId: run.node_id } : {}),
          checkStartedAt: typeof run.started_at === "string" ? run.started_at : null,
        },
      });
    }
    return out;
  }

  if (eventName === "push") {
    const defaultBranch = payload.repository?.default_branch;
    if (typeof defaultBranch === "string" && payload.ref === `refs/heads/${defaultBranch}` && payload.deleted !== true) {
      out.sweepRepos.push(repo);
    }
    return out;
  }

  return out;
}

const PR_FIELDS = "number url state isDraft isCrossRepository authorAssociation author{login} headRefOid headRefName baseRefName mergeable updatedAt";

/** GraphQL used by the conflict sweep and by the per-signal PR lookup; one call per repo page or per PR. */
export const OPEN_PRS_QUERY = `query($o:String!,$r:String!,$base:String,$cursor:String){repository(owner:$o,name:$r){
pullRequests(states:OPEN,first:50,after:$cursor,baseRefName:$base){pageInfo{hasNextPage endCursor}
nodes{${PR_FIELDS}}}}}`;

/** One PR, for conflict signals (mergeability is in PR_FIELDS). */
export const ONE_PR_QUERY = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){
pullRequest(number:$n){${PR_FIELDS}}}}`;

/**
 * One PR plus the current runs of one check name on its head commit, in the same read, for check signals.
 * GitHub GraphQL: Commit.checkSuites(filterBy: CheckSuiteFilter{checkName}), CheckSuite.checkRuns(filterBy:
 * CheckRunFilter{checkName, checkType: LATEST}).
 */
export const ONE_PR_WITH_CHECK_QUERY = `query($o:String!,$r:String!,$n:Int!,$check:String!){repository(owner:$o,name:$r){
pullRequest(number:$n){${PR_FIELDS}
commits(last:1){nodes{commit{oid checkSuites(first:20,filterBy:{checkName:$check}){nodes{
checkRuns(first:10,filterBy:{checkName:$check,checkType:LATEST}){nodes{id status conclusion startedAt}}}}}}}}}}`;

export interface GraphPr {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  isCrossRepository: boolean;
  authorAssociation: string;
  author: { login: string } | null;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  updatedAt: string;
  /** Only with ONE_PR_WITH_CHECK_QUERY. */
  commits?: { nodes: Array<{ commit: { oid: string; checkSuites: { nodes: Array<{ checkRuns: { nodes: CheckRunState[] } }> } } }> };
}

/** The check runs ONE_PR_WITH_CHECK_QUERY read on the PR's head commit; undefined if not read or not the head. */
function checkRunsFromGraph(pr: GraphPr): CheckRunState[] | undefined {
  const commit = pr.commits?.nodes?.[0]?.commit;
  if (!commit || commit.oid !== pr.headRefOid) return undefined;
  return commit.checkSuites.nodes.flatMap((suite) => suite.checkRuns.nodes);
}

export function prStateFromGraph(repo: string, pr: GraphPr, config: DoerWakeConfig): PrState {
  const checkRuns = checkRunsFromGraph(pr);
  return {
    ...(checkRuns ? { checkRuns } : {}),
    repo,
    number: pr.number,
    head: pr.headRefOid,
    headRef: pr.headRefName,
    draft: pr.isDraft,
    url: pr.url,
    open: pr.state === "OPEN",
    trusted: pr.isCrossRepository === false && isTrustedAuthor(config, pr.authorAssociation, pr.author?.login),
    mergeable: pr.mergeable,
  };
}
