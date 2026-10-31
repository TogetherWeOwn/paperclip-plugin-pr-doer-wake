import { randomInt } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { DoerWakeConfig } from "./config.js";
import { CONTEXT_SOURCE, DB_NAMESPACE } from "./constants.js";
import { fingerprint, policySkip, type Signal, type SkipOutcome } from "./github.js";
import {
  CARD_BY_COMMENT_SQL,
  CARD_BY_IDENTIFIER_SQL,
  claimSql,
  forgetSql,
  markWakeAttemptedSql,
  prUrlPatterns,
  recordOutcomeSql,
  releaseWakeAttemptSql,
} from "./sql.js";

export interface CardRef {
  id: string;
  identifier: string;
  status: string;
  via: "branch" | "comment" | "description";
}

export type Outcome =
  | "duplicate"
  | "skipped_state"
  | SkipOutcome
  | "deferred"
  | "no_card"
  | "ambiguous_card"
  | "held_status"
  | "held_blockers"
  | "shadow"
  | "woken"
  | "refused"
  | "wake_unconfirmed"
  | "error";

export interface WakeResult {
  fingerprint: string;
  outcome: Outcome;
  card?: string;
  detail?: string;
}

/**
 * The claim incarnation an attempt holds (sql.ts claimFence): every write of the attempt is fenced on it, so an
 * attempt another one superseded changes nothing. `createdAt` is the text Postgres returned or this attempt's token.
 */
export interface Claim {
  createdAt: string;
  attempts: number;
}

/** What an earlier attempt of this fingerprint already did (wake_ledger phase columns), and this retry's claim. */
export interface RetryPhases {
  claim: Claim;
  issueId: string | null;
  commentPostedAt: string | null;
  wakeAttemptedAt: string | null;
}

/**
 * requestWakeup refusals the host throws before anything is queued, matched by their exact message (the host
 * answers every handler error as JSON-RPC INTERNAL_ERROR -32603 with the bare message, plugin-worker-manager.ts
 * errorCodeForWorkerHostError, so the code tells nothing). Sources in /app/server/src/services:
 * plugin-host-services.ts requestWakeup guards and budget pre-check (2354-2374); heartbeat/queue.ts enqueueWakeup
 * (notFound 2127, budget 2545, invokability 2559; each writes a skipped request, never a queued one); budgets.ts
 * reconcileScope reasons (573-602); agent-invokability.ts. `retry`: the host asks to wait while run accounting
 * settles, so the mark is released and the sweep retries. The others are decisions (`refused`, not retried). Any
 * other message, however it reads, may come after the request was queued and is wake_unconfirmed.
 */
const HOST_REFUSALS: ReadonlyArray<{ message: RegExp; retry: boolean }> = [
  { message: /^Issue has no assigned agent to wake$/, retry: false },
  { message: /^Issue is not wakeable in status: [a-z_]+$/, retry: false },
  { message: /^Issue is blocked by unresolved blockers$/, retry: false },
  { message: /^Agent not found$/, retry: false },
  { message: /^Agent no longer exists$/, retry: false },
  { message: /^Agent is not invokable in its current state$/, retry: false },
  { message: /^Agent is not invokable because its reporting chain is invalid$/, retry: false },
  { message: /^(Company|Agent|Project) cannot start work because recorded usage has no reliable price\.$/, retry: false },
  { message: /^Project cannot start work because its budget hard-stop is still exceeded\.$/, retry: false },
  { message: /^(Company|Agent) is paused because its budget hard-stop was reached\.$/, retry: false },
  { message: /^(Company|Project) is paused and cannot start new work\.$/, retry: false },
  { message: /^Budget pause requires a policy or an explicit operator resume\.$/, retry: false },
  { message: /^(Company|Agent|Project) cannot start work while completed runs await accounting\.$/, retry: true },
  { message: /^New work must wait while a native run recovers its unfinished accounting\.$/, retry: true },
];

function hostRefusal(message: string): { retry: boolean } | null {
  return HOST_REFUSALS.find((r) => r.message.test(message)) ?? null;
}

/**
 * requestWakeup failures that prove the host never ran the handler, so nothing was queued and a retry is safe:
 * - the host's idle-sleep hold, answered before dispatch (plugin-worker-manager.ts handleWorkerRequest:
 *   WORKER_UNAVAILABLE -32000 "Plugin is held for idle sleep");
 * - the SDK refusing locally before sending (worker-rpc-host.js callHost: "worker RPC host is not running").
 * The code alone proves nothing: the SDK's cleanup() and the host's rejectAllPending also answer -32000 for calls
 * that were already sent ("Worker RPC host is shutting down", a worker exit), and those may have been queued.
 * Everything else, timeouts included, may have been accepted.
 */
function provablyNotSent(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ((error as { code?: unknown }).code === -32000 && error.message === "Plugin is held for idle sleep") return true;
  return /worker RPC host is not running/.test(error.message);
}

function namespace(ctx: PluginContext): string {
  return ctx.db.namespace || DB_NAMESPACE;
}

export type CardResolution = { kind: "card"; card: CardRef } | { kind: "none" } | { kind: "ambiguous"; detail: string };

/** How long the repo -> projects map and full issue texts are reused across resolutions (finding M1). */
export const SCAN_CACHE_TTL_MS = 60_000;
const PROJECT_SCAN_CAP = 200;
const ISSUE_SCAN_CAP = 200;
const OPEN_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;

type ProjectMap = { at: number; overflow: boolean; repos: Map<string, string[]> };
type IssueText = { title: string; description: string; originKind?: string; identifier: string | null; status: string };
interface ScanCache {
  projects: Map<string, ProjectMap>;
  /** `${companyId}|${issueId}|${updatedAt}`: an edited issue gets a new key, so the cached text is never stale. */
  issues: Map<string, { at: number; text: IssueText | null }>;
}
/** Keyed by the worker's context, so a new context (a restart, a test harness) starts empty. */
const scanCaches = new WeakMap<PluginContext, ScanCache>();

function scanCache(ctx: PluginContext): ScanCache {
  let cache = scanCaches.get(ctx);
  if (!cache) scanCaches.set(ctx, (cache = { projects: new Map(), issues: new Map() }));
  return cache;
}

/** `owner/repo` from a workspace repoUrl (https, scp-style or ssh), lowercased; null for anything else. */
export function repoOfUrl(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null;
  const normalized = repoUrl.toLowerCase().replace(/\/$/, "").replace(/\.git$/, "");
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+)$/.exec(normalized);
  return match?.[1] ?? null;
}

/**
 * The company's repo -> project ids map from project workspace URLs, built once per SCAN_CACHE_TTL_MS instead of
 * one listWorkspaces call per project on every resolution. `overflow`: more projects than the scan covers.
 */
async function projectsByRepo(ctx: PluginContext, companyId: string): Promise<ProjectMap> {
  const cache = scanCache(ctx);
  const hit = cache.projects.get(companyId);
  if (hit && Date.now() - hit.at < SCAN_CACHE_TTL_MS) return hit;
  const projects = await ctx.projects.list({ companyId, limit: PROJECT_SCAN_CAP + 1 });
  const map: ProjectMap = { at: Date.now(), overflow: projects.length > PROJECT_SCAN_CAP, repos: new Map() };
  if (!map.overflow) {
    for (const project of projects) {
      for (const { repoUrl } of await ctx.projects.listWorkspaces(project.id, companyId)) {
        const repo = repoOfUrl(repoUrl);
        if (!repo) continue;
        const ids = map.repos.get(repo) ?? [];
        if (!ids.includes(project.id)) ids.push(project.id);
        map.repos.set(repo, ids);
      }
    }
  }
  cache.projects.set(companyId, map);
  return map;
}

/** The full title and description of an issue the list returned as a (possibly truncated) summary. */
async function issueText(ctx: PluginContext, companyId: string, summary: { id: string; updatedAt?: unknown }): Promise<IssueText | null> {
  const cache = scanCache(ctx);
  const version = summary.updatedAt instanceof Date ? summary.updatedAt.toISOString() : summary.updatedAt ? String(summary.updatedAt) : null;
  const key = version ? `${companyId}|${summary.id}|${version}` : null;
  const now = Date.now();
  const hit = key ? cache.issues.get(key) : undefined;
  if (hit && now - hit.at < SCAN_CACHE_TTL_MS) return hit.text;
  const issue = await ctx.issues.get(summary.id, companyId);
  const text = issue ? { title: issue.title ?? "", description: issue.description ?? "", originKind: issue.originKind, identifier: issue.identifier ?? null, status: issue.status } : null;
  if (key) {
    for (const [k, v] of cache.issues) if (now - v.at >= SCAN_CACHE_TTL_MS) cache.issues.delete(k);
    cache.issues.set(key, { at: now, text });
  }
  return text;
}

/**
 * The owning card from both interim paths (README "Card resolution"), found without regard to status or the card's
 * current assignee: an ineligible owner (done, handed to the Reviewer) must hold the wake, not pass it to another card.
 * The owner is the one card both paths together name. Two or more distinct candidates (branch vs comment, or PR-link
 * comments on two cards) mean the owner is unknown: the wake is held rather than sent to a card that may be
 * unrelated. Eligibility is checked on the owner afterwards (wakeForSignal).
 * A head branch names a card only when that card's project has a workspace for the PR's repo: a branch name is not
 * tied to the PR the way an exact PR-link is, so `TOG-123-tmp` in an unrelated repo names nothing.
 */
export async function resolveCard(ctx: PluginContext, companyId: string, config: DoerWakeConfig, signal: Signal): Promise<CardResolution> {
  const exclude = config.excludeAgentIds.join(",");
  type Row = { id: string; identifier: string; status: string; project_id?: string | null };
  const candidates = new Map<string, CardRef>();
  // The SDK has no text search. Resolve the repo from project workspace URLs and scan only open
  // issues in matching projects. Fail closed if the complete scan would exceed the budget.
  const projectMap = await projectsByRepo(ctx, companyId);
  if (projectMap.overflow) return { kind: "ambiguous", detail: `project scan exceeds ${PROJECT_SCAN_CAP} projects` };
  const repoProjects = projectMap.repos.get(signal.repo.toLowerCase()) ?? [];
  if (signal.headRef) {
    const match = new RegExp(config.branchIdentifierPattern).exec(signal.headRef);
    if (match?.[1]) {
      const [row] = await ctx.db.query<Row>(CARD_BY_IDENTIFIER_SQL, [companyId, match[1]]);
      if (row?.project_id && repoProjects.includes(row.project_id)) {
        candidates.set(row.id, { id: row.id, identifier: row.identifier, status: row.status, via: "branch" });
      }
    }
  }
  const { like, regex } = prUrlPatterns(signal.repo, signal.number);
  for (const row of await ctx.db.query<Row>(CARD_BY_COMMENT_SQL, [companyId, like, regex, exclude])) {
    if (!candidates.has(row.id)) candidates.set(row.id, { id: row.id, identifier: row.identifier, status: row.status, via: "comment" });
  }
  const ambiguous = (): CardResolution => ({ kind: "ambiguous", detail: [...candidates.values()].map((c) => `${c.via}:${c.identifier}`).join(" ") });
  // Already ambiguous: the description scan could only add candidates.
  if (candidates.size > 1) return ambiguous();
  const urlPattern = new RegExp(regex, "i");
  const summaries = [];
  for (const projectId of repoProjects) {
    for (const status of OPEN_STATUSES) {
      const remaining = ISSUE_SCAN_CAP - summaries.length;
      const page = await ctx.issues.list({ companyId, projectId, status, limit: remaining + 1 });
      if (page.length > remaining) return { kind: "ambiguous", detail: `project issue scan exceeds ${ISSUE_SCAN_CAP} open issues` };
      summaries.push(...page);
    }
  }
  for (const summary of summaries) {
    if (summary.originKind === "chat_channel") continue;
    const issue = await issueText(ctx, companyId, summary);
    if (!issue || issue.originKind === "chat_channel") continue;
    if (urlPattern.test(issue.title) || urlPattern.test(issue.description)) {
      if (!candidates.has(summary.id)) candidates.set(summary.id, { id: summary.id, identifier: issue.identifier ?? summary.id, status: issue.status, via: "description" });
    }
  }
  if (candidates.size > 1) return ambiguous();
  const [card] = candidates.values();
  return card ? { kind: "card", card } : { kind: "none" };
}

export function evidenceComment(signal: Signal): string {
  const head = signal.head.slice(0, 8);
  const pr = `**${signal.repo}#${signal.number}** (${signal.url})`;
  switch (signal.state) {
    case "review_findings":
      return `${pr}: **Paperclip Review scored ${signal.detail.score ?? "<5"}/5** on head \`${head}\`: ${signal.detail.checkUrl || signal.url}. ` +
        "Address every finding in ONE push. Don't merge or rebase the base branch into it unless it conflicts.";
    case "ci_red":
      return `${pr}: **\`${signal.detail.checkName}\` ${signal.detail.conclusion}** on head \`${head}\`: ${signal.detail.checkUrl || signal.url}. ` +
        "Open the log, fix the cause on this branch and push once.";
    case "conflict":
      return `${pr}: **merge conflict with its base** on head \`${head}\`. Update it from the base branch, resolve, run the tests and push once.`;
  }
}

/** Record the outcome under this attempt's claim. False: another attempt superseded it, nothing was written. */
export async function recordOutcome(ctx: PluginContext, companyId: string, fp: string, outcome: string, issueId: string | null, claim: Claim): Promise<boolean> {
  const written = await ctx.db.execute(recordOutcomeSql(namespace(ctx)), [companyId, fp, outcome, issueId, claim.createdAt, claim.attempts]);
  return written.rowCount === 1;
}

/**
 * Drop a never-woken row so a later genuine signal can claim the fingerprint again (forgetSql). False when the row
 * no longer carries this attempt's claim token: a newer signal was folded into it meanwhile, so it must be re-read.
 */
export async function forget(ctx: PluginContext, companyId: string, fp: string, token: string): Promise<boolean> {
  const deleted = await ctx.db.execute(forgetSql(namespace(ctx)), [companyId, fp, token]);
  return deleted.rowCount === 1;
}

/** Detail of a `duplicate` that lost the ledger row to another attempt; the caller looks at the row again. */
export const CLAIM_TAKEN = "taken by another attempt";

/**
 * Detail of a `duplicate` from an attempt that stalled while another one took its row (claimFence): it changed
 * nothing, and the attempt that holds the row now decides. Its signal is covered: that attempt read GitHub later.
 */
export const SUPERSEDED = "superseded by another attempt";

/**
 * requestWakeup was sent but its result is unknown (lost reply, timeout, worker stopped mid-call). The host may
 * have queued, deferred or coalesced it, and plugins can neither have it dedupe by idempotencyKey nor read its
 * receipt (agent_wakeup_requests is not a plugin core-read table), so it is never requested again: at most once.
 * This is the accepted missed-wake case of the delivery contract; it is counted by this fixed log message
 * (plugin_logs, level warn) and by the ledger outcome.
 */
export const WAKE_UNCONFIRMED_LOG = "pr-doer-wake: wake_unconfirmed (request sent, result unknown; not repeated)";

export async function markUnconfirmed(ctx: PluginContext, companyId: string, fp: string, issueId: string | null, detail: string, claim: Claim): Promise<WakeResult> {
  // Logged only by the attempt that holds the row, so the log counts each row once.
  if (!(await recordOutcome(ctx, companyId, fp, "wake_unconfirmed", issueId, claim))) return { fingerprint: fp, outcome: "duplicate", detail: SUPERSEDED };
  ctx.logger.warn(WAKE_UNCONFIRMED_LOG, { fingerprint: fp, issueId, error: detail });
  return { fingerprint: fp, outcome: "wake_unconfirmed", detail };
}

/**
 * A claim token as a timestamptz literal with microseconds (the last three digits random), so two attempts never
 * write the same one. Used as created_at by a new claim and as updated_at by a re-claim (plugin.ts retryRow).
 */
export function claimToken(): string {
  return new Date().toISOString().replace("Z", `${String(randomInt(1000)).padStart(3, "0")}Z`);
}

/** Insert the ledger row; null if it already exists. */
async function claim(ctx: PluginContext, companyId: string, fp: string, signal: Signal): Promise<Claim | null> {
  const createdAt = claimToken();
  const claimed = await ctx.db.execute(claimSql(namespace(ctx)), [
    companyId, fp, signal.repo, signal.number, signal.head, signal.state, JSON.stringify(signal), createdAt,
  ]);
  return claimed.rowCount === 0 ? null : { createdAt, attempts: 0 };
}

/**
 * The PR state could not be read right now (GitHub 5xx, secret rate limit). Claim the fingerprint and leave it
 * retryable so the sweep re-reads the PR, instead of dropping the signal.
 */
export async function deferSignal(ctx: PluginContext, companyId: string, config: DoerWakeConfig, signal: Signal, detail: string): Promise<WakeResult> {
  const fp = fingerprint(signal);
  const policy = policySkip(config, signal);
  if (policy) return { fingerprint: fp, outcome: policy };
  const held = await claim(ctx, companyId, fp, signal);
  if (!held) return { fingerprint: fp, outcome: "duplicate", detail: CLAIM_TAKEN };
  if (!(await recordOutcome(ctx, companyId, fp, "error", null, held))) return { fingerprint: fp, outcome: "duplicate", detail: SUPERSEDED };
  ctx.logger.warn("pr-doer-wake: PR state unavailable; the sweep job re-reads it", { fingerprint: fp, error: detail });
  return { fingerprint: fp, outcome: "deferred", detail };
}

/**
 * Wake the card that owns this PR at most once per (PR, head SHA, state).
 * Order: repo policy (stoppedRepos, wakeStates) -> draft/trust gate -> atomic ledger claim -> owning card ->
 * eligibility and hold checks -> wake-attempt mark -> requestWakeup. requestWakeup stays the
 * authority for terminal status, blockers, assignee, agent state and budget. A retry (`opts.retry`, already re-claimed
 * by the sweep or a redelivery) skips the claim and every phase the ledger says already happened, and re-resolves the
 * owner: if the current evidence no longer names exactly the card an earlier attempt chose, it holds (never
 * retargets). Every write is fenced on this attempt's claim (sql.ts claimFence): once another attempt has taken the
 * row, this one changes nothing and returns SUPERSEDED. Once a wake may have reached the host it is never requested
 * again (see markUnconfirmed). The mark is released only when the request provably never left or the host refused it
 * before queueing anything and asked to wait.
 */
export async function wakeForSignal(
  ctx: PluginContext,
  companyId: string,
  config: DoerWakeConfig,
  signal: Signal,
  opts: { retry?: RetryPhases } = {},
): Promise<WakeResult> {
  const fp = fingerprint(signal);
  const retry = opts.retry;
  // Final guard for every caller (webhook, conflict sweep, retries): the policy may have changed since the signal.
  // A retry applies the same policy before its GitHub read (plugin.ts retryRow), so it never gets here with one.
  const policy = policySkip(config, signal);
  if (policy) return { fingerprint: fp, outcome: policy };
  if (signal.trusted === false) return { fingerprint: fp, outcome: "untrusted" };
  if (signal.draft === true) return { fingerprint: fp, outcome: "skipped_draft" };
  if (signal.draft === null) return { fingerprint: fp, outcome: "draft_unknown" };

  const held = retry ? retry.claim : await claim(ctx, companyId, fp, signal);
  if (!held) return { fingerprint: fp, outcome: "duplicate", detail: CLAIM_TAKEN };
  if (retry?.wakeAttemptedAt) return markUnconfirmed(ctx, companyId, fp, retry.issueId, "an earlier attempt already requested the wake", held);

  const ns = namespace(ctx);
  const superseded = (card?: CardRef | null): WakeResult => ({ fingerprint: fp, outcome: "duplicate", card: card?.identifier, detail: SUPERSEDED });
  /** Record a decision under this attempt's claim; a superseded attempt reports SUPERSEDED instead. */
  const decide = async (outcome: string, issueId: string | null, result: WakeResult): Promise<WakeResult> =>
    (await recordOutcome(ctx, companyId, fp, outcome, issueId, held)) ? result : superseded();
  let card: CardRef | null = null;
  try {
    const resolved = await resolveCard(ctx, companyId, config, signal);
    let ambiguous = resolved.kind === "ambiguous" ? resolved.detail : null;
    if (!ambiguous && retry?.issueId && (resolved.kind !== "card" || resolved.card.id !== retry.issueId)) {
      // An earlier attempt chose another card than the evidence names now.
      ambiguous = `ledger:${retry.issueId} now:${resolved.kind === "card" ? resolved.card.identifier : "none"}`;
    }
    if (ambiguous) {
      const result = await decide(`ambiguous_card:${ambiguous}`.slice(0, 200), retry?.issueId ?? null, { fingerprint: fp, outcome: "ambiguous_card", detail: ambiguous });
      if (result.outcome === "ambiguous_card") ctx.logger.warn("pr-doer-wake: owning card is ambiguous; held", { fingerprint: fp, detail: ambiguous });
      return result;
    }
    card = resolved.kind === "card" ? resolved.card : null;
    // Pending, not terminal: the doer's PR-link comment often lands after a fast check. The sweep retries no_card
    // with backoff (retryableSql), re-checking the same card if one was chosen.
    const issue = card ? await ctx.issues.get(card.id, companyId) : null;
    if (!card || !issue) return await decide("no_card", null, { fingerprint: fp, outcome: "no_card" });
    card = { ...card, identifier: issue.identifier ?? card.identifier, status: issue.status };
    if (!issue.assigneeAgentId || config.excludeAgentIds.includes(issue.assigneeAgentId)) {
      return await decide("no_card", card.id, { fingerprint: fp, outcome: "no_card", card: card.identifier, detail: "assignee not eligible" });
    }
    // Holds on the card are never final for the fingerprint: no wake was requested, so a later genuine signal on the
    // same head and state resumes the row (plugin.ts resumable) and wakes once the card is eligible. Not polled.
    const status = issue.status;
    if (["backlog", "done", "cancelled"].includes(status) || (config.skipBlockedStatus && status === "blocked")) {
      return await decide(`held_status:${status}`, card.id, { fingerprint: fp, outcome: "held_status", card: card.identifier, detail: status });
    }
    const relations = await ctx.issues.relations.get(card.id, companyId);
    const open = relations.blockedBy.filter((b) => b.status !== "done");
    if (open.length > 0) {
      return await decide("held_blockers", card.id, { fingerprint: fp, outcome: "held_blockers", card: card.identifier, detail: open.map((b) => b.identifier ?? b.id).join(",") });
    }
    if (config.shadow) {
      const result = await decide(`shadow:${card.identifier}`, card.id, { fingerprint: fp, outcome: "shadow", card: card.identifier });
      if (result.outcome === "shadow") ctx.logger.info("pr-doer-wake shadow: would wake", { fingerprint: fp, card: card.identifier, via: card.via });
      return result;
    }
    const reason = `github_pr_${signal.state}`;
    const mark = new Date().toISOString();
    let marked: { rowCount: number };
    try {
      marked = await ctx.db.execute(markWakeAttemptedSql(ns), [companyId, fp, card.id, mark, held.createdAt, held.attempts]);
    } catch (error) {
      // The mark may have committed with its reply lost, but requestWakeup was not called: undo it so the sweep
      // retries instead of closing the row as wake_unconfirmed with zero wakes.
      await ctx.db.execute(releaseWakeAttemptSql(ns), [companyId, fp, mark, "error"]).catch(() => undefined);
      throw error;
    }
    // Another attempt took this row while this one stalled (it requested the wake, held it or forgot it), or a wake
    // was already marked: leave it.
    if (marked.rowCount !== 1) return superseded(card);
    let result: Awaited<ReturnType<PluginContext["issues"]["requestWakeup"]>>;
    try {
      // Only this call is classified below: a failure after it returned must never be read as "not sent".
      result = await ctx.issues.requestWakeup(card.id, companyId, {
        reason,
        contextSource: CONTEXT_SOURCE,
        idempotencyKey: `pr-doer-wake:${fp}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const refusal = hostRefusal(message);
      if (refusal && !refusal.retry) {
        // Nothing was queued: the mark is released, so a later genuine signal may wake once the cause is gone
        // (blockers cleared, agent resumed); the sweep does not poll it.
        const released = await ctx.db.execute(releaseWakeAttemptSql(ns), [companyId, fp, mark, `refused:${message.slice(0, 120)}`]);
        return released.rowCount === 1 ? { fingerprint: fp, outcome: "refused", card: card.identifier, detail: message } : superseded(card);
      }
      if (refusal || provablyNotSent(error)) {
        await ctx.db.execute(releaseWakeAttemptSql(ns), [companyId, fp, mark, "error"]);
        ctx.logger.warn("pr-doer-wake: wake request not queued by the host; the sweep job retries it", { fingerprint: fp, error: message });
        return { fingerprint: fp, outcome: "deferred", card: card.identifier, detail: message };
      }
      return { ...(await markUnconfirmed(ctx, companyId, fp, card.id, message, held)), card: card.identifier };
    }
    const runId = result.runId ?? undefined;
    // The wake was queued. If this write fails the mark stays set, so the row is never requested again; it is later
    // closed as wake_unconfirmed (an overcount of missed wakes, never a second wake). The same if another attempt
    // took the row while requestWakeup hung past the stuck window and already closed it so.
    const recorded = await recordOutcome(ctx, companyId, fp, `woken:${result.runId ?? "coalesced"}`, card.id, held).catch((error) =>
      error instanceof Error ? error.message : String(error));
    if (recorded !== true) {
      ctx.logger.warn("pr-doer-wake: woken, but recording the outcome failed; the wake mark stays and it is not repeated", {
        fingerprint: fp, runId, error: recorded === false ? SUPERSEDED : recorded,
      });
    }
    return { fingerprint: fp, outcome: "woken", card: card.identifier, detail: runId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A failed write leaves the row in flight: the sweep takes it after the stuck window.
    const recorded = await recordOutcome(ctx, companyId, fp, "error", card?.id ?? null, held).catch(() => null);
    if (recorded === false) return superseded(card);
    ctx.logger.warn("pr-doer-wake: wake failed; the sweep job retries it", { fingerprint: fp, error: message });
    return { fingerprint: fp, outcome: "error", card: card?.identifier, detail: message };
  }
}
