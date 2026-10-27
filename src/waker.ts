import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { DoerWakeConfig } from "./config.js";
import { CONTEXT_SOURCE, DB_NAMESPACE } from "./constants.js";
import { fingerprint, type Signal, type SkipOutcome } from "./github.js";
import {
  CARD_BY_COMMENT_SQL,
  CARD_BY_IDENTIFIER_SQL,
  COMMENT_EXISTS_SQL,
  RUN_SINCE_SQL,
  claimSql,
  markCommentPostedSql,
  markWakeAttemptedSql,
  prUrlPatterns,
  recordOutcomeSql,
} from "./sql.js";

export interface CardRef {
  id: string;
  identifier: string;
  status: string;
  via: "branch" | "comment" | "ledger";
}

export type Outcome =
  | "duplicate"
  | "skipped_state"
  | SkipOutcome
  | "deferred"
  | "no_card"
  | "held_status"
  | "held_blockers"
  | "shadow"
  | "woken"
  | "refused"
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

function namespace(ctx: PluginContext): string {
  return ctx.db.namespace || DB_NAMESPACE;
}

export async function resolveCard(ctx: PluginContext, companyId: string, config: DoerWakeConfig, signal: Signal): Promise<CardRef | null> {
  const exclude = config.excludeAgentIds.join(",");
  if (signal.headRef) {
    const match = new RegExp(config.branchIdentifierPattern).exec(signal.headRef);
    if (match?.[1]) {
      const rows = await ctx.db.query<{ id: string; identifier: string; status: string }>(CARD_BY_IDENTIFIER_SQL, [companyId, match[1], exclude]);
      if (rows[0]) return { id: rows[0].id, identifier: rows[0].identifier, status: rows[0].status, via: "branch" };
    }
  }
  const { like, regex } = prUrlPatterns(signal.repo, signal.number);
  const rows = await ctx.db.query<{ id: string; identifier: string; status: string }>(CARD_BY_COMMENT_SQL, [companyId, like, regex, exclude]);
  return rows[0] ? { id: rows[0].id, identifier: rows[0].identifier, status: rows[0].status, via: "comment" } : null;
}

/** A retry stays on the card the first attempt chose (it may already carry the evidence comment). */
async function cardFromLedger(ctx: PluginContext, companyId: string, issueId: string): Promise<CardRef | null> {
  const issue = await ctx.issues.get(issueId, companyId);
  return issue ? { id: issue.id, identifier: issue.identifier ?? issue.id, status: issue.status, via: "ledger" } : null;
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
  if (!config.wakeStates.includes(signal.state)) return { fingerprint: fp, outcome: "skipped_state" };
  if (!(await claim(ctx, companyId, fp, signal))) return { fingerprint: fp, outcome: "duplicate" };
  await recordOutcome(ctx, companyId, fp, "error", null);
  ctx.logger.warn("pr-doer-wake: PR state unavailable; the sweep job re-reads it", { fingerprint: fp, error: detail });
  return { fingerprint: fp, outcome: "deferred", detail };
}

/**
 * Wake the card that owns this PR exactly once per (PR, head SHA, state).
 * Order: state filter -> draft/trust gate -> atomic ledger claim -> card -> hold checks -> evidence comment -> requestWakeup.
 * requestWakeup stays the authority for terminal status, blockers, assignee and budget.
 * A retry (`opts.retry`) skips the claim and every phase the ledger says already happened.
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
  if (!config.wakeStates.includes(signal.state)) return { fingerprint: fp, outcome: "skipped_state" };
  if (signal.trusted === false) return { fingerprint: fp, outcome: "untrusted" };
  if (signal.draft === true) return { fingerprint: fp, outcome: "skipped_draft" };
  if (signal.draft === null) return { fingerprint: fp, outcome: "draft_unknown" };

  if (!retry && !(await claim(ctx, companyId, fp, signal))) return { fingerprint: fp, outcome: "duplicate" };

  const ns = namespace(ctx);
  let card: CardRef | null = null;
  try {
    card = (retry?.issueId ? await cardFromLedger(ctx, companyId, retry.issueId) : null) ?? (await resolveCard(ctx, companyId, config, signal));
    if (!card) {
      await recordOutcome(ctx, companyId, fp, "no_card", null);
      return { fingerprint: fp, outcome: "no_card" };
    }
    const issue = await ctx.issues.get(card.id, companyId);
    const status = issue?.status ?? card.status;
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
    if (retry?.wakeAttemptedAt) {
      // The earlier requestWakeup may have succeeded with its reply lost: look for the run it created.
      const runs = await ctx.db.query<{ id: string }>(RUN_SINCE_SQL, [companyId, card.id, retry.wakeAttemptedAt, CONTEXT_SOURCE, reason]);
      if (runs[0]) {
        await recordOutcome(ctx, companyId, fp, `woken:${runs[0].id}`, card.id);
        return { fingerprint: fp, outcome: "woken", card: card.identifier, detail: runs[0].id };
      }
    }
    await ctx.db.execute(markWakeAttemptedSql(ns), [companyId, fp, card.id]);
    try {
      const result = await ctx.issues.requestWakeup(card.id, companyId, {
        reason,
        contextSource: CONTEXT_SOURCE,
        idempotencyKey: `pr-doer-wake:${fp}`,
      });
      await recordOutcome(ctx, companyId, fp, `woken:${result.runId ?? "coalesced"}`, card.id);
      return { fingerprint: fp, outcome: "woken", card: card.identifier, detail: result.runId ?? undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (HOST_REFUSALS.some((m) => message.includes(m))) {
        await recordOutcome(ctx, companyId, fp, `refused:${message.slice(0, 120)}`, card.id);
        return { fingerprint: fp, outcome: "refused", card: card.identifier, detail: message };
      }
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordOutcome(ctx, companyId, fp, "error", card?.id ?? null).catch(() => undefined);
    ctx.logger.warn("pr-doer-wake: wake failed; the sweep job retries it", { fingerprint: fp, error: message });
    return { fingerprint: fp, outcome: "error", card: card?.identifier, detail: message };
  }
}
