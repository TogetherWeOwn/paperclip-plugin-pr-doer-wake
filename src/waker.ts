import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { DoerWakeConfig } from "./config.js";
import { CONTEXT_SOURCE, DB_NAMESPACE } from "./constants.js";
import { fingerprint, type Signal } from "./github.js";
import {
  CARD_BY_COMMENT_SQL,
  CARD_BY_IDENTIFIER_SQL,
  claimSql,
  prUrlPatterns,
  recordOutcomeSql,
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
  | "skipped_draft"
  | "draft_unknown"
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
    case "merged":
      return `${pr} **was merged**. Close out this card (done if nothing else remains) or say what is left.`;
  }
}

async function record(ctx: PluginContext, companyId: string, fp: string, outcome: string, issueId: string | null) {
  await ctx.db.execute(recordOutcomeSql(namespace(ctx)), [companyId, fp, outcome, issueId]);
}

/**
 * Wake the card that owns this PR exactly once per (PR, head SHA, state).
 * Order: state filter -> draft gate -> atomic ledger claim -> card -> hold checks -> evidence comment -> requestWakeup.
 * requestWakeup stays the authority for terminal status, blockers, assignee and budget.
 */
export async function wakeForSignal(
  ctx: PluginContext,
  companyId: string,
  config: DoerWakeConfig,
  signal: Signal,
  opts: { retry?: boolean } = {},
): Promise<WakeResult> {
  const fp = fingerprint(signal);
  if (!config.wakeStates.includes(signal.state)) return { fingerprint: fp, outcome: "skipped_state" };
  if (signal.draft === true) return { fingerprint: fp, outcome: "skipped_draft" };
  if (signal.draft === null) return { fingerprint: fp, outcome: "draft_unknown" };

  if (!opts.retry) {
    const claimed = await ctx.db.execute(claimSql(namespace(ctx)), [
      companyId, fp, signal.repo, signal.number, signal.head, signal.state, JSON.stringify(signal),
    ]);
    if (claimed.rowCount === 0) return { fingerprint: fp, outcome: "duplicate" };
  }

  let card: CardRef | null = null;
  try {
    card = await resolveCard(ctx, companyId, config, signal);
    if (!card) {
      await record(ctx, companyId, fp, "no_card", null);
      return { fingerprint: fp, outcome: "no_card" };
    }
    const issue = await ctx.issues.get(card.id, companyId);
    const status = issue?.status ?? card.status;
    if (["backlog", "done", "cancelled"].includes(status) || (config.skipBlockedStatus && status === "blocked")) {
      await record(ctx, companyId, fp, `held_status:${status}`, card.id);
      return { fingerprint: fp, outcome: "held_status", card: card.identifier, detail: status };
    }
    const relations = await ctx.issues.relations.get(card.id, companyId);
    const open = relations.blockedBy.filter((b) => b.status !== "done");
    if (open.length > 0) {
      await record(ctx, companyId, fp, "held_blockers", card.id);
      return { fingerprint: fp, outcome: "held_blockers", card: card.identifier, detail: open.map((b) => b.identifier ?? b.id).join(",") };
    }
    if (config.shadow) {
      await record(ctx, companyId, fp, `shadow:${card.identifier}`, card.id);
      ctx.logger.info("pr-doer-wake shadow: would wake", { fingerprint: fp, card: card.identifier, via: card.via });
      return { fingerprint: fp, outcome: "shadow", card: card.identifier };
    }
    if (config.postEvidenceComment && !opts.retry) {
      await ctx.issues.createComment(card.id, evidenceComment(signal), companyId);
    }
    try {
      const result = await ctx.issues.requestWakeup(card.id, companyId, {
        reason: `github_pr_${signal.state}`,
        contextSource: CONTEXT_SOURCE,
        idempotencyKey: `pr-doer-wake:${fp}`,
      });
      await record(ctx, companyId, fp, `woken:${result.runId ?? "coalesced"}`, card.id);
      return { fingerprint: fp, outcome: "woken", card: card.identifier, detail: result.runId ?? undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (HOST_REFUSALS.some((m) => message.includes(m))) {
        await record(ctx, companyId, fp, `refused:${message.slice(0, 120)}`, card.id);
        return { fingerprint: fp, outcome: "refused", card: card.identifier, detail: message };
      }
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await record(ctx, companyId, fp, "error", card?.id ?? null).catch(() => undefined);
    ctx.logger.warn("pr-doer-wake: wake failed; the sweep job retries it", { fingerprint: fp, error: message });
    return { fingerprint: fp, outcome: "error", card: card?.identifier, detail: message };
  }
}
