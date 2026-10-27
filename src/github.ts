import { createHmac, timingSafeEqual } from "node:crypto";
import type { DoerWakeConfig } from "./config.js";
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
  detail: {
    score?: number | null;
    checkName?: string;
    checkUrl?: string;
    conclusion?: string;
  };
}

export interface StatusFailure {
  repo: string;
  sha: string;
  context: string;
  url: string;
}

export interface ParsedEvent {
  signals: Signal[];
  upsertIndex: PrIndexEntry[];
  removeIndex: Array<{ repo: string; number: number }>;
  /** Repos whose default branch moved: open PRs may now conflict. */
  sweepRepos: string[];
  statusFailures: StatusFailure[];
}

/** Conclusions that mean the check really failed. cancelled/stale/skipped/neutral/action_required never wake. */
export const RED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);

/** pull_request actions that change what the index holds (head, branch, draft, base, open/closed). */
export const INDEX_PR_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review", "converted_to_draft", "closed", "edited"]);

/**
 * Cheap pre-filter run BEFORE signature verification. Every verification resolves the webhook secret, and the host
 * allows only 30 secret resolutions per minute per plugin and company (createRateLimiter(30, 60_000) in
 * /app/server/src/services/plugin-secrets-handler.ts:195). Most org deliveries (check_run created/success,
 * pull_request labeled/assigned, feature-branch pushes, pending statuses) can never act, so they are acknowledged
 * without resolving anything. Skipping an unverified event is safe: it performs no work.
 */
export function mayAct(eventName: string, payload: Json): boolean {
  switch (eventName) {
    case "pull_request":
      return INDEX_PR_ACTIONS.has(String(payload?.action ?? ""));
    case "check_run":
      return payload?.action === "completed" && RED_CONCLUSIONS.has(String(payload?.check_run?.conclusion ?? ""));
    case "status":
      return payload?.state === "failure" || payload?.state === "error";
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
  return { signals: [], upsertIndex: [], removeIndex: [], sweepRepos: [], statusFailures: [] };
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
    const entry: PrIndexEntry = {
      repo,
      number: pr.number,
      head: String(pr.head?.sha ?? ""),
      headRef: typeof pr.head?.ref === "string" ? pr.head.ref : null,
      base: typeof pr.base?.ref === "string" ? pr.base.ref : null,
      draft: pr.draft === true,
      url: String(pr.html_url ?? `https://github.com/${payload.repository.full_name}/pull/${pr.number}`),
    };
    if (payload.action === "closed") {
      out.removeIndex.push({ repo, number: pr.number });
      if (pr.merged === true) {
        out.signals.push({ repo, number: pr.number, head: entry.head, state: "merged", url: entry.url, headRef: entry.headRef, draft: false, detail: {} });
      }
      return out;
    }
    out.upsertIndex.push(entry);
    if (pr.state === "open" && !entry.draft && pr.mergeable_state === "dirty") {
      out.signals.push({ repo, number: pr.number, head: entry.head, state: "conflict", url: entry.url, headRef: entry.headRef, draft: false, detail: {} });
    }
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
        detail: { score, checkName: name, checkUrl: String(run.html_url ?? run.details_url ?? ""), conclusion },
      });
    }
    return out;
  }

  if (eventName === "status") {
    const state = String(payload.state ?? "");
    const context = String(payload.context ?? "");
    if ((state === "failure" || state === "error") && context !== config.reviewCheckName && isGatingCheck(config, repo, context)) {
      out.statusFailures.push({ repo, sha: String(payload.sha ?? ""), context, url: String(payload.target_url ?? "") });
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

/** GraphQL used by the conflict sweep and by draft lookups; one call per repo page or per PR. */
export const OPEN_PRS_QUERY = `query($o:String!,$r:String!,$base:String,$cursor:String){repository(owner:$o,name:$r){
pullRequests(states:OPEN,first:50,after:$cursor,baseRefName:$base){pageInfo{hasNextPage endCursor}
nodes{number url isDraft headRefOid headRefName baseRefName mergeable}}}}`;

export const ONE_PR_QUERY = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){
pullRequest(number:$n){number url state isDraft headRefOid headRefName baseRefName mergeable}}}`;

export interface GraphPr {
  number: number;
  url: string;
  state?: string;
  isDraft: boolean;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
}

export function indexFromGraph(repo: string, pr: GraphPr): PrIndexEntry {
  return { repo, number: pr.number, head: pr.headRefOid, headRef: pr.headRefName, base: pr.baseRefName, draft: pr.isDraft, url: pr.url };
}
