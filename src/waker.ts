import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { DoerWakeConfig } from "./config.js";
import { CONTEXT_SOURCE, DB_NAMESPACE } from "./constants.js";
import { fingerprint, policySkip, type Signal, type SkipOutcome } from "./github.js";
import {
  CARD_BY_COMMENT_SQL,
  CARD_BY_IDENTIFIER_SQL,
  COMMENT_EXISTS_SQL,
  claimSql,
  forgetSql,
  markCommentPostedSql,
  markWakeAttemptedSql,
  prUrlPatterns,
  recordOutcomeSql,
  releaseWakeAttemptSql,
} from "./sql.js";

export interface CardRef {
  id: string;
  identifier: string;
  status: string;
  via: "branch" | "comment";
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

/** What an earlier attempt of this fingerprint already did (wake_ledger phase columns). */
export interface RetryPhases {
  issueId: string | null;
  commentPostedAt: string | null;
  wakeAttemptedAt: string | null;
}

/** Messages thrown by requestWakeup's host guards (/app/server/src/services/plugin-host-services.ts:2354-2372). */
const HOST_REFUSALS = [
  "Issue has no assigned agent to wake",
  "Issue is not wakeable in status",
  "Issue is blocked by unresolved blockers",
  "budget",
  "Budget",
  "paused",
];

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

/**
 * The owning card from both interim paths (README "Card resolution"), found without regard to status or the card's
 * current assignee: an ineligible owner (done, handed to the Reviewer) must hold the wake, not pass it to another card.
 * The owner is the one card both paths together name. Two or more distinct candidates (branch vs comment, or PR-link
 * comments on two cards) mean the owner is unknown: the wake is held rather than sent to a card that may be
 * unrelated. Eligibility is checked on the owner afterwards (wakeForSignal).
 */
export async function resolveCard(ctx: PluginContext, companyId: string, config: DoerWakeConfig, signal: Signal): Promise<CardResolution> {
  const exclude = config.excludeAgentIds.join(",");
  type Row = { id: string; identifier: string; status: string };
  const candidates = new Map<string, CardRef>();
  if (signal.headRef) {
    const match = new RegExp(config.branchIdentifierPattern).exec(signal.headRef);
    if (match?.[1]) {
      const [row] = await ctx.db.query<Row>(CARD_BY_IDENTIFIER_SQL, [companyId, match[1]]);
      if (row) candidates.set(row.id, { id: row.id, identifier: row.identifier, status: row.status, via: "branch" });
    }
  }
  const { like, regex } = prUrlPatterns(signal.repo, signal.number);
  for (const row of await ctx.db.query<Row>(CARD_BY_COMMENT_SQL, [companyId, like, regex, exclude])) {
    if (!candidates.has(row.id)) candidates.set(row.id, { id: row.id, identifier: row.identifier, status: row.status, via: "comment" });
  }
  const cards = [...candidates.values()];
  if (cards.length > 1) return { kind: "ambiguous", detail: cards.map((c) => `${c.via}:${c.identifier}`).join(" ") };
  return cards[0] ? { kind: "card", card: cards[0] } : { kind: "none" };
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

export async function recordOutcome(ctx: PluginContext, companyId: string, fp: string, outcome: string, issueId: string | null) {
  await ctx.db.execute(recordOutcomeSql(namespace(ctx)), [companyId, fp, outcome, issueId]);
}

/** Drop a never-woken row so a later genuine signal can claim the fingerprint again (forgetSql). */
export async function forget(ctx: PluginContext, companyId: string, fp: string) {
  await ctx.db.execute(forgetSql(namespace(ctx)), [companyId, fp]);
}

/**
 * requestWakeup was sent but its result is unknown (lost reply, timeout, worker stopped mid-call). The host may
 * have queued, deferred or coalesced it, and plugins can neither have it dedupe by idempotencyKey nor read its
 * receipt (agent_wakeup_requests is not a plugin core-read table), so it is never requested again: at most once.
 * This is the accepted missed-wake case of the delivery contract; it is counted by this fixed log message
 * (plugin_logs, level warn) and by the ledger outcome.
 */
export const WAKE_UNCONFIRMED_LOG = "pr-doer-wake: wake_unconfirmed (request sent, result unknown; not repeated)";

export async function markUnconfirmed(ctx: PluginContext, companyId: string, fp: string, issueId: string | null, detail: string): Promise<WakeResult> {
  await recordOutcome(ctx, companyId, fp, "wake_unconfirmed", issueId);
  ctx.logger.warn(WAKE_UNCONFIRMED_LOG, { fingerprint: fp, issueId, error: detail });
  return { fingerprint: fp, outcome: "wake_unconfirmed", detail };
}

async function claim(ctx: PluginContext, companyId: string, fp: string, signal: Signal): Promise<boolean> {
  const claimed = await ctx.db.execute(claimSql(namespace(ctx)), [
    companyId, fp, signal.repo, signal.number, signal.head, signal.state, JSON.stringify(signal),
  ]);
  return claimed.rowCount !== 0;
}

/**
 * The PR state could not be read right now (GitHub 5xx, secret rate limit). Claim the fingerprint and leave it
 * retryable so the sweep re-reads the PR, instead of dropping the signal.
 */
export async function deferSignal(ctx: PluginContext, companyId: string, config: DoerWakeConfig, signal: Signal, detail: string): Promise<WakeResult> {
  const fp = fingerprint(signal);
  const policy = policySkip(config, signal);
  if (policy) return { fingerprint: fp, outcome: policy };
  if (!(await claim(ctx, companyId, fp, signal))) return { fingerprint: fp, outcome: "duplicate" };
  await recordOutcome(ctx, companyId, fp, "error", null);
  ctx.logger.warn("pr-doer-wake: PR state unavailable; the sweep job re-reads it", { fingerprint: fp, error: detail });
  return { fingerprint: fp, outcome: "deferred", detail };
}

/**
 * Wake the card that owns this PR at most once per (PR, head SHA, state).
 * Order: repo policy (stoppedRepos, wakeStates) -> draft/trust gate -> atomic ledger claim -> owning card ->
 * eligibility and hold checks -> evidence comment -> wake-attempt mark -> requestWakeup. requestWakeup stays the
 * authority for terminal status, blockers, assignee and budget. A retry (`opts.retry`, already re-claimed by the
 * sweep) skips the claim and every phase the ledger says already happened, and re-resolves the owner: if the
 * current evidence no longer names exactly the card an earlier attempt chose, it holds (never retargets). Once a wake
 * may have reached the host it is never requested again (see markUnconfirmed). The mark is released only when the
 * request provably never left.
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
  const policy = policySkip(config, signal);
  if (policy) {
    if (retry) await forget(ctx, companyId, fp);
    return { fingerprint: fp, outcome: policy };
  }
  if (signal.trusted === false) return { fingerprint: fp, outcome: "untrusted" };
  if (signal.draft === true) return { fingerprint: fp, outcome: "skipped_draft" };
  if (signal.draft === null) return { fingerprint: fp, outcome: "draft_unknown" };

  if (!retry && !(await claim(ctx, companyId, fp, signal))) return { fingerprint: fp, outcome: "duplicate" };
  if (retry?.wakeAttemptedAt) return markUnconfirmed(ctx, companyId, fp, retry.issueId, "an earlier attempt already requested the wake");

  const ns = namespace(ctx);
  let card: CardRef | null = null;
  try {
    const resolved = await resolveCard(ctx, companyId, config, signal);
    let ambiguous = resolved.kind === "ambiguous" ? resolved.detail : null;
    if (!ambiguous && retry?.issueId && (resolved.kind !== "card" || resolved.card.id !== retry.issueId)) {
      // An earlier attempt chose (and may have commented on) another card than the evidence names now.
      ambiguous = `ledger:${retry.issueId} now:${resolved.kind === "card" ? resolved.card.identifier : "none"}`;
    }
    if (ambiguous) {
      await recordOutcome(ctx, companyId, fp, `ambiguous_card:${ambiguous}`.slice(0, 200), retry?.issueId ?? null);
      ctx.logger.warn("pr-doer-wake: owning card is ambiguous; held", { fingerprint: fp, detail: ambiguous });
      return { fingerprint: fp, outcome: "ambiguous_card", detail: ambiguous };
    }
    card = resolved.kind === "card" ? resolved.card : null;
    // Pending, not terminal: the doer's PR-link comment often lands after a fast check. The sweep retries no_card
    // with backoff (retryableSql), re-checking the same card if one was chosen.
    const issue = card ? await ctx.issues.get(card.id, companyId) : null;
    if (!card || !issue) {
      await recordOutcome(ctx, companyId, fp, "no_card", null);
      return { fingerprint: fp, outcome: "no_card" };
    }
    card = { ...card, identifier: issue.identifier ?? card.identifier, status: issue.status };
    if (!issue.assigneeAgentId || config.excludeAgentIds.includes(issue.assigneeAgentId)) {
      await recordOutcome(ctx, companyId, fp, "no_card", card.id);
      return { fingerprint: fp, outcome: "no_card", card: card.identifier, detail: "assignee not eligible" };
    }
    const status = issue.status;
    if (["backlog", "done", "cancelled"].includes(status) || (config.skipBlockedStatus && status === "blocked")) {
      await recordOutcome(ctx, companyId, fp, `held_status:${status}`, card.id);
      return { fingerprint: fp, outcome: "held_status", card: card.identifier, detail: status };
    }
    const relations = await ctx.issues.relations.get(card.id, companyId);
    const open = relations.blockedBy.filter((b) => b.status !== "done");
    if (open.length > 0) {
      await recordOutcome(ctx, companyId, fp, "held_blockers", card.id);
      return { fingerprint: fp, outcome: "held_blockers", card: card.identifier, detail: open.map((b) => b.identifier ?? b.id).join(",") };
    }
    if (config.shadow) {
      await recordOutcome(ctx, companyId, fp, `shadow:${card.identifier}`, card.id);
      ctx.logger.info("pr-doer-wake shadow: would wake", { fingerprint: fp, card: card.identifier, via: card.via });
      return { fingerprint: fp, outcome: "shadow", card: card.identifier };
    }
    if (config.postEvidenceComment && !retry?.commentPostedAt) {
      const body = evidenceComment(signal);
      const posted = retry ? (await ctx.db.query(COMMENT_EXISTS_SQL, [companyId, card.id, body])).length > 0 : false;
      if (!posted) await ctx.issues.createComment(card.id, body, companyId);
      await ctx.db.execute(markCommentPostedSql(ns), [companyId, fp, card.id]);
    }
    const reason = `github_pr_${signal.state}`;
    const mark = new Date().toISOString();
    let marked: { rowCount: number };
    try {
      marked = await ctx.db.execute(markWakeAttemptedSql(ns), [companyId, fp, card.id, mark]);
    } catch (error) {
      // The mark may have committed with its reply lost, but requestWakeup was not called: undo it so the sweep
      // retries instead of closing the row as wake_unconfirmed with zero wakes.
      await ctx.db.execute(releaseWakeAttemptSql(ns), [companyId, fp, mark]).catch(() => undefined);
      throw error;
    }
    if (marked.rowCount !== 1) {
      // Another attempt took this row while this one stalled: it requested the wake or forgot the row. Leave it.
      return { fingerprint: fp, outcome: "duplicate", card: card.identifier, detail: "another attempt holds the wake" };
    }
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
      if (HOST_REFUSALS.some((m) => message.includes(m))) {
        await recordOutcome(ctx, companyId, fp, `refused:${message.slice(0, 120)}`, card.id);
        return { fingerprint: fp, outcome: "refused", card: card.identifier, detail: message };
      }
      if (provablyNotSent(error)) {
        await ctx.db.execute(releaseWakeAttemptSql(ns), [companyId, fp, mark]);
        ctx.logger.warn("pr-doer-wake: wake request never reached the host; the sweep job retries it", { fingerprint: fp, error: message });
        return { fingerprint: fp, outcome: "error", card: card.identifier, detail: message };
      }
      return { ...(await markUnconfirmed(ctx, companyId, fp, card.id, message)), card: card.identifier };
    }
    const runId = result.runId ?? undefined;
    // The wake was queued. If this write fails the mark stays set, so the row is never requested again; it is later
    // closed as wake_unconfirmed (an overcount of missed wakes, never a second wake).
    await recordOutcome(ctx, companyId, fp, `woken:${result.runId ?? "coalesced"}`, card.id).catch((error) => {
      ctx.logger.warn("pr-doer-wake: woken, but recording the outcome failed; the wake mark stays and it is not repeated", {
        fingerprint: fp, runId, error: error instanceof Error ? error.message : String(error),
      });
    });
    return { fingerprint: fp, outcome: "woken", card: card.identifier, detail: runId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordOutcome(ctx, companyId, fp, "error", card?.id ?? null).catch(() => undefined);
    ctx.logger.warn("pr-doer-wake: wake failed; the sweep job retries it", { fingerprint: fp, error: message });
    return { fingerprint: fp, outcome: "error", card: card?.identifier, detail: message };
  }
}
