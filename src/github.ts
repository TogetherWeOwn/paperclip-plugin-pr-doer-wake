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
   * Every check run on the PR's head commit as GitHub reports it now (LATEST per check suite, all pages).
   * Undefined when not read (conflict signals); a check signal without it never wakes.
   */
  checkRuns?: CheckRunState[];
}

export interface CheckRunState {
  /** GraphQL node id, the same value as the webhook's check_run.node_id. */
  id: string;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  url?: string | null;
  /** Node id of the run's check suite: a run supersedes only runs of the same name in the same suite. */
  suite?: string;
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
export const SUBSCRIBED_EVENTS = new Set(["pull_request", "check_run"]);

/** Shape of GitHub's X-Hub-Signature-256 header; anything else is rejected before any company or secret work. */
export const SIGNATURE_RE = /^sha256=[0-9a-f]{64}$/;

/** author_association values trusted to name a card by branch (GitHub REST/GraphQL CommentAuthorAssociation). */
export const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** Conclusions that trigger a wake. cancelled, stale, skipped, neutral and startup_failure do not. */
export const RED_CONCLUSIONS = new Set(["failure", "timed_out", "action_required"]);
/** The same accepted conclusions apply to the review check. */
export const REVIEW_RED_CONCLUSIONS = new Set(["failure", "timed_out", "action_required"]);

/** A synchronize delivery is a candidate; the GitHub lookup decides mergeability. */
export const CONFLICT_PR_ACTIONS = new Set(["synchronize"]);

/**
 * Cheap pre-filter run BEFORE signature verification. Most org deliveries (check_run created/success,
 * pull_request labeled/assigned, feature-branch pushes) can never act, so they are acknowledged without loading
 * company config or touching a secret. Skipping an unverified event is safe: it performs no work. Deliveries that
 * pass still verify against the worker-memory secret cache (src/secrets.ts) before any per-company work.
 */
export function mayAct(eventName: string, payload: Json): boolean {
  switch (eventName) {
    case "pull_request":
      return payload?.action === "closed" || (CONFLICT_PR_ACTIONS.has(String(payload?.action ?? "")) && isOpenNonDraftPr(payload?.pull_request));
    case "check_run":
      return payload?.action === "completed" && RED_CONCLUSIONS.has(String(payload?.check_run?.conclusion ?? ""));
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

function isOpenNonDraftPr(pr: Json | undefined): boolean {
  return pr?.state === "open" && pr?.draft !== true;
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

export type CheckVerdict = { kind: "red"; run: CheckRunState } | Exclude<PrCheck, { kind: "ok" }>;

/**
 * Is the signal's state still red on this head, by GitHub's newest run of each relevant check name in each check
 * suite? Webhooks arrive late and out of order and checks are re-run on the same head, so a delivered conclusion
 * alone never wakes. A re-run supersedes a run only within its own suite: an independent suite (another app or
 * workflow) exposing the same name never hides a genuine failure.
 * Relevant: for review_findings the review check only; for ci_red every gating check (isGatingCheck, never the
 * review), because the state is per head: when the delivered check recovered but another gating check is red, the
 * signal is still red and that check is the evidence (no pending evidence has to be kept in the ledger).
 * Not red now is transient while GitHub's read lags the webhook (the delivered run is not listed yet, or still listed
 * as not completed) and otherwise check_not_red: a newer run's own completion delivery starts again.
 */
export function checkVerdict(runs: CheckRunState[] | undefined, signal: Signal, config: DoerWakeConfig): CheckVerdict {
  if (!runs) return { kind: "transient", detail: "check runs not read" };
  // A head-level re-evaluation (RECHECK_PR_ACTIONS) names no check and no run: it judges every relevant check, and
  // there is no delivered run whose absence could mean read lag, so not red now is check_not_red at once.
  const review = signal.state === "review_findings";
  const own = signal.detail.checkName ?? (review ? config.reviewCheckName : undefined);
  const relevant = (name: string) => isGatingCheck(config, signal.repo, name) && (review ? name === own : name !== config.reviewCheckName);
  const red = review ? REVIEW_RED_CONCLUSIONS : RED_CONCLUSIONS;
  const latest = new Map<string, CheckRunState>(); // per (suite, name)
  for (const run of runs) {
    if (!relevant(run.name)) continue;
    const key = `${run.suite ?? ""}\n${run.name}`;
    const seen = latest.get(key);
    if (!seen || startedMs(run) > startedMs(seen)) latest.set(key, run);
  }
  const redNow = [...latest.values()]
    .filter((r) => r.status === "COMPLETED" && red.has(String(r.conclusion ?? "").toLowerCase()))
    .sort((a, b) => (a.name === own ? -1 : b.name === own ? 1 : a.name.localeCompare(b.name)));
  if (redNow[0]) return { kind: "red", run: redNow[0] };
  const ownRuns = runs.filter((r) => r.name === own);
  // Read lag can only be told from a delivered run's identity; without one (head-level, or an old ledger row) not red
  // now is final, never transient forever.
  if (signal.detail.checkRunId) {
    const delivered = ownRuns.find((r) => r.id === signal.detail.checkRunId);
    if (delivered && delivered.status !== "COMPLETED") {
      return { kind: "transient", detail: `GitHub still lists the delivered run as ${delivered.status.toLowerCase()}` };
    }
    const deliveredStart = signal.detail.checkStartedAt ? Date.parse(signal.detail.checkStartedAt) : Number.NaN;
    const newestOwn = ownRuns.reduce((max, r) => Math.max(max, startedMs(r)), Number.NEGATIVE_INFINITY);
    if (!delivered && (ownRuns.length === 0 || (!Number.isNaN(deliveredStart) && newestOwn < deliveredStart))) {
      return { kind: "transient", detail: `GitHub does not list the failing ${own} run yet` };
    }
  }
  const mine = [...latest.values()].filter((r) => r.name === own).sort((a, b) => startedMs(b) - startedMs(a))[0];
  const detail = mine ? `latest ${own} run ${(mine.status === "COMPLETED" ? String(mine.conclusion) : mine.status).toLowerCase()}` : "no gating check red";
  return { kind: "skip", outcome: "check_not_red", detail };
}

/**
 * May this signal wake, given the PR as GitHub reports it now? Closed, merged, re-pushed, untrusted and draft PRs
 * never do; nor does a check signal whose state is no longer red, or a conflict GitHub no longer reports.
 */
export function evaluate(pr: PrState, signal: Signal, config: DoerWakeConfig): PrCheck {
  if (!pr.open) return { kind: "skip", outcome: "skipped_closed" };
  if (pr.head !== signal.head) return { kind: "skip", outcome: "stale_head", detail: pr.head };
  if (!pr.trusted) return { kind: "skip", outcome: "untrusted" };
  if (pr.draft) return { kind: "skip", outcome: "skipped_draft" };
  let detail = signal.detail;
  if (signal.state === "conflict") {
    if (pr.mergeable !== "CONFLICTING") {
      // GitHub computes mergeability lazily: UNKNOWN is read again by the sweep.
      return pr.mergeable === "UNKNOWN" ? { kind: "transient", detail: "mergeability not computed yet" } : { kind: "skip", outcome: "not_conflicting" };
    }
  } else {
    const verdict = checkVerdict(pr.checkRuns, signal, config);
    if (verdict.kind !== "red") return verdict;
    const run = verdict.run;
    if (run.id !== signal.detail.checkRunId) {
      // The evidence is the run that is red now (a newer red run, or another gating check).
      detail = {
        ...detail,
        checkName: run.name,
        checkUrl: run.url ?? "",
        conclusion: String(run.conclusion).toLowerCase(),
        checkRunId: run.id,
        checkStartedAt: run.startedAt,
      };
    }
  }
  return { kind: "ok", signal: { ...signal, detail, draft: false, trusted: true, headRef: pr.headRef ?? signal.headRef } };
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

/** Any check not in the explicit ignore list is actionable. */
export function isGatingCheck(config: DoerWakeConfig, repo: string, name: string): boolean {
  if (config.ignoreChecks.includes(name)) return false;
  return true;
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
    // A candidate only: the authoritative lookup decides open, draft, trust, head and mergeability.
    const pr = payload.pull_request as Json | undefined;
    if (!pr || typeof pr.number !== "number" || !CONFLICT_PR_ACTIONS.has(String(payload.action)) || !isOpenNonDraftPr(pr)) return out;
    const states: WakeState[] = ["conflict"];
    for (const state of states) {
      out.signals.push({
        repo,
        number: pr.number,
        head: String(pr.head?.sha ?? ""),
        state,
        url: String(pr.html_url ?? `https://github.com/${payload.repository.full_name}/pull/${pr.number}`),
        headRef: typeof pr.head?.ref === "string" ? pr.head.ref : null,
        draft: null,
        trusted: null,
        detail: {},
      });
    }
    return out;
  }

  if (eventName === "check_run") {
    const run = payload.check_run as Json | undefined;
    if (!run || payload.action !== "completed") return out;
    const name = String(run.name ?? "");
    const conclusion = String(run.conclusion ?? "");
    if (!isGatingCheck(config, repo, name)) return out;
    const isReview = name === config.reviewCheckName;
    let state: WakeState | null = null;
    let score: number | null = null;
    if (isReview) {
      if (REVIEW_RED_CONCLUSIONS.has(conclusion)) {
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


  return out;
}

const PR_FIELDS = "number url state isDraft isCrossRepository authorAssociation author{login} headRefOid headRefName baseRefName mergeable updatedAt";

/** GraphQL used by the conflict sweep and by the per-signal PR lookup; one call per repo page or per PR. */
export const OPEN_PRS_QUERY = `query($o:String!,$r:String!,$base:String,$cursor:String){repository(owner:$o,name:$r){
pullRequests(states:OPEN,first:50,after:$cursor,baseRefName:$base){pageInfo{hasNextPage endCursor}
nodes{${PR_FIELDS}}}}}`;

/** One PR, for every signal (mergeability is in PR_FIELDS; check signals then read HEAD_SUITES_QUERY on its head). */
export const ONE_PR_QUERY = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){
pullRequest(number:$n){${PR_FIELDS}}}}`;

const RUNS = "checkRuns(first:100,after:$runs,filterBy:{checkType:LATEST}){pageInfo{hasNextPage endCursor} nodes{id name status conclusion startedAt url}}";
const SUITES = `checkSuites(first:100,after:$suites){pageInfo{hasNextPage endCursor} nodes{id ${RUNS}}}`;

/**
 * The check suites and their first runs on the PR's head commit, read by the `headRefOid` ONE_PR_QUERY returned (never
 * through `commits(last:1)`, which GitHub caps at 250 commits); `$suites` pages through the rest. checkVerdict filters
 * the relevant names; plugin.ts headCheckRuns pages the runs of each suite with SUITE_RUNS_QUERY. GitHub GraphQL:
 * Repository.object(oid:), Commit.checkSuites, CheckSuite.checkRuns(filterBy: CheckRunFilter{checkType: LATEST}).
 * Reading check suites needs the Checks read permission, which fine-grained personal access tokens cannot get
 * (README "GitHub token").
 */
export const HEAD_SUITES_QUERY = `query($o:String!,$r:String!,$oid:GitObjectID!,$suites:String,$runs:String){repository(owner:$o,name:$r){
object(oid:$oid){... on Commit{${SUITES}}}}}`;

/** The next page of check runs in one check suite. */
export const SUITE_RUNS_QUERY = `query($id:ID!,$runs:String){node(id:$id){... on CheckSuite{${RUNS}}}}`;

type Page<T> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] };
export type GraphRuns = Page<Omit<CheckRunState, "suite">>;
export type GraphSuites = Page<{ id: string; checkRuns: GraphRuns }>;

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
}

/** `checkRuns`: every run on the head commit (plugin.ts headCheckRuns); omitted when not read. */
export function prStateFromGraph(repo: string, pr: GraphPr, config: DoerWakeConfig, checkRuns?: CheckRunState[]): PrState {
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
