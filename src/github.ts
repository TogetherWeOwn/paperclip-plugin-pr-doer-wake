import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeLogin, type DoerWakeConfig } from "./config.js";
import type { WakeState } from "./constants.js";

/** What the plugin remembers about an open PR (from pull_request webhooks or a GraphQL lookup). */
export interface PrIndexEntry {
  repo: string; // lowercase "org/repo"
  number: number;
  head: string;
  headRef: string | null;
  base: string | null;
  draft: boolean;
  url: string;
  /** False once closed or merged (kept as a tombstone so late deliveries cannot reopen it). */
  open: boolean;
  /** Head branch in the base repo and a trusted author; see isTrustedAuthor. */
  trusted: boolean;
  /** pull_request.updated_at / GraphQL updatedAt. Older payloads never overwrite a newer entry. */
  updatedAt: string | null;
}

export interface Signal {
  repo: string;
  number: number;
  head: string;
  state: WakeState;
  url: string;
  headRef: string | null;
  /** Known draft flag from the event itself; null means look it up in the index. */
  draft: boolean | null;
  /** Known trust from the event itself; null means look it up in the index. */
  trusted: boolean | null;
  detail: {
    score?: number | null;
    checkName?: string;
    checkUrl?: string;
    conclusion?: string;
  };
}

export interface ParsedEvent {
  signals: Signal[];
  upsertIndex: PrIndexEntry[];
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

/** pull_request actions that change what the index holds (head, branch, draft, base, open/closed). */
export const INDEX_PR_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review", "converted_to_draft", "closed", "edited"]);

/**
 * Cheap pre-filter run BEFORE signature verification. Most org deliveries (check_run created/success,
 * pull_request labeled/assigned, feature-branch pushes) can never act, so they are acknowledged without loading
 * company config or touching a secret. Skipping an unverified event is safe: it performs no work. Deliveries that
 * pass still verify against the worker-memory secret cache (src/secrets.ts) before any per-company work.
 */
export function mayAct(eventName: string, payload: Json): boolean {
  switch (eventName) {
    case "pull_request":
      return INDEX_PR_ACTIONS.has(String(payload?.action ?? ""));
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
  return { signals: [], upsertIndex: [], sweepRepos: [] };
}

/** OWNER/MEMBER/COLLABORATOR, or a login listed in trustedAuthors (bots report NONE). */
export function isTrustedAuthor(config: DoerWakeConfig, association: unknown, login: unknown): boolean {
  if (typeof association === "string" && TRUSTED_ASSOCIATIONS.has(association.toUpperCase())) return true;
  return typeof login === "string" && config.trustedAuthors.includes(normalizeLogin(login));
}

export type SkipOutcome = "skipped_closed" | "stale_head" | "untrusted" | "skipped_draft" | "draft_unknown";

export type PrCheck =
  | { kind: "ok"; signal: Signal }
  | { kind: "skip"; outcome: SkipOutcome; detail?: string }
  | { kind: "transient"; detail: string };

/** Is the PR, as the index currently knows it, still one this signal may wake? */
export function evaluate(entry: PrIndexEntry, signal: Signal): PrCheck {
  if (!entry.open) return { kind: "skip", outcome: "skipped_closed" };
  if (entry.head !== signal.head) return { kind: "skip", outcome: "stale_head", detail: entry.head };
  if (!entry.trusted) return { kind: "skip", outcome: "untrusted" };
  if (entry.draft) return { kind: "skip", outcome: "skipped_draft" };
  return { kind: "ok", signal: { ...signal, draft: false, trusted: true, headRef: signal.headRef ?? entry.headRef } };
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
    const pr = payload.pull_request as Json | undefined;
    if (!pr || typeof pr.number !== "number") return out;
    // Fork heads (head.repo differs or was deleted) and outsider authors can pick any branch name, so they must
    // never name a card. check_run.pull_requests already omits fork PRs (GitHub docs), so the index carries trust.
    const headRepo = pr.head?.repo?.full_name;
    const baseRepo = pr.base?.repo?.full_name ?? payload.repository.full_name;
    const sameRepo = typeof headRepo === "string" && headRepo.toLowerCase() === String(baseRepo).toLowerCase();
    const closed = payload.action === "closed" || pr.state !== "open";
    const entry: PrIndexEntry = {
      repo,
      number: pr.number,
      head: String(pr.head?.sha ?? ""),
      headRef: typeof pr.head?.ref === "string" ? pr.head.ref : null,
      base: typeof pr.base?.ref === "string" ? pr.base.ref : null,
      draft: pr.draft === true,
      url: String(pr.html_url ?? `https://github.com/${payload.repository.full_name}/pull/${pr.number}`),
      open: !closed,
      trusted: sameRepo && isTrustedAuthor(config, pr.author_association, pr.user?.login),
      updatedAt: typeof pr.updated_at === "string" ? pr.updated_at : null,
    };
    out.upsertIndex.push(entry);
    const base = { repo, number: pr.number, head: entry.head, url: entry.url, headRef: entry.headRef, trusted: entry.trusted, detail: {} };
    if (payload.action === "closed") {
      if (pr.merged === true) out.signals.push({ ...base, state: "merged", draft: false });
      return out;
    }
    if (!closed && !entry.draft && pr.mergeable_state === "dirty") out.signals.push({ ...base, state: "conflict", draft: false });
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
        detail: { score, checkName: name, checkUrl: String(run.html_url ?? run.details_url ?? ""), conclusion },
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

/** GraphQL used by the conflict sweep and by PR lookups; one call per repo page or per PR. */
export const OPEN_PRS_QUERY = `query($o:String!,$r:String!,$base:String,$cursor:String){repository(owner:$o,name:$r){
pullRequests(states:OPEN,first:50,after:$cursor,baseRefName:$base){pageInfo{hasNextPage endCursor}
nodes{${PR_FIELDS}}}}}`;

export const ONE_PR_QUERY = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){
pullRequest(number:$n){${PR_FIELDS}}}}`;

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

export function indexFromGraph(repo: string, pr: GraphPr, config: DoerWakeConfig): PrIndexEntry {
  return {
    repo,
    number: pr.number,
    head: pr.headRefOid,
    headRef: pr.headRefName,
    base: pr.baseRefName,
    draft: pr.isDraft,
    url: pr.url,
    open: pr.state === "OPEN",
    trusted: pr.isCrossRepository === false && isTrustedAuthor(config, pr.authorAssociation, pr.author?.login),
    updatedAt: typeof pr.updatedAt === "string" ? pr.updatedAt : null,
  };
}
