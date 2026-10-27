/**
 * Every statement this plugin sends through ctx.db. Tests run each one through a verbatim copy of the
 * host validators (/app/server/src/services/plugin-database.ts validatePluginRuntimeQuery/Execute).
 * Core reads use only manifest coreReadTables `issues` and `issue_comments`
 * (PLUGIN_DATABASE_CORE_READ_TABLES in packages/shared/src/constants.ts:1442).
 */
export function claimSql(ns: string): string {
  return `insert into ${ns}.wake_ledger (company_id, fingerprint, repo, pull_number, head_sha, state, signal)
values ($1, $2, $3, $4, $5, $6, $7::jsonb) on conflict do nothing`;
}

/** Cheap pre-check so a redelivered or repeated red check costs no GitHub lookup. The claim stays the atomic gate. */
export function seenSql(ns: string): string {
  return `select fingerprint from ${ns}.wake_ledger where company_id = $1 and fingerprint = $2`;
}

/** Outcome of the attempt that holds the row. `attempts` counts sweep retries and is bumped only by reclaimSql. */
export function recordOutcomeSql(ns: string): string {
  return `update ${ns}.wake_ledger set outcome = $3, issue_id = $4, updated_at = now()
where company_id = $1 and fingerprint = $2`;
}

/**
 * A sweep takes a retry row only if nobody changed it since the select ($3 outcome, $4 updated_at as text):
 * rowCount 1 means this sweep owns the retry, 0 means another sweep (or the webhook path) got there first.
 */
export function reclaimSql(ns: string): string {
  return `update ${ns}.wake_ledger set outcome = 'retrying', attempts = attempts + 1, updated_at = now()
where company_id = $1 and fingerprint = $2 and outcome = $3 and updated_at::text = $4`;
}

/** Phase marks: what a retry must not repeat (migrations/002_wake_phases.sql). */
export function markCommentPostedSql(ns: string): string {
  return `update ${ns}.wake_ledger set comment_posted_at = now(), issue_id = $3, updated_at = now()
where company_id = $1 and fingerprint = $2`;
}

export function markWakeAttemptedSql(ns: string): string {
  return `update ${ns}.wake_ledger set wake_attempted_at = now(), issue_id = $3, updated_at = now()
where company_id = $1 and fingerprint = $2`;
}

/**
 * Undo the wake mark when requestWakeup provably never reached the host (the mark's own DB reply was lost before
 * the call, or the host refused before dispatch), so the sweep may retry it instead of closing it unconfirmed.
 */
export function releaseWakeAttemptSql(ns: string): string {
  return `update ${ns}.wake_ledger set wake_attempted_at = null, outcome = 'error', updated_at = now()
where company_id = $1 and fingerprint = $2`;
}

/** Sweep retries per row after the first attempt (webhook or sweep). */
export const MAX_RETRIES = 4;

/**
 * Rows the sweep finishes: transient errors after 2 minutes, rows still at 'claimed' or 'retrying' after 10 minutes
 * (the worker stopped mid-attempt), and rows without a resolvable owning card yet (the doer's PR-link comment often
 * lands after a fast check) with a growing backoff of 5, 10, 15, 20 minutes. All bounded by MAX_RETRIES; compacted
 * tombstones (compactSql) are never retried. Each row is then taken with reclaimSql.
 */
export function retryableSql(ns: string): string {
  return `select fingerprint, outcome, updated_at::text as updated_at, signal::text as signal, issue_id::text as issue_id,
comment_posted_at::text as comment_posted_at, wake_attempted_at::text as wake_attempted_at
from ${ns}.wake_ledger
where company_id = $1 and attempts < ${MAX_RETRIES} and signal <> '{}'::jsonb and (
(outcome = 'error' and updated_at < now() - interval '2 minutes')
or (outcome in ('claimed', 'retrying') and updated_at < now() - interval '10 minutes')
or (outcome = 'no_card' and updated_at < now() - interval '5 minutes' * (attempts + 1)))
order by updated_at asc limit 20`;
}

/**
 * Retention: after 30 days a row keeps only its dedupe key and outcome (a tombstone of a few hundred bytes); the
 * signal payload is dropped. Rows are never deleted: a still-open PR on the same head in the same state would
 * otherwise wake again (for example a later default-branch push re-sweeping a conflict).
 */
export function compactSql(ns: string): string {
  return `update ${ns}.wake_ledger set signal = '{}'::jsonb
where updated_at < now() - interval '30 days' and signal <> '{}'::jsonb`;
}

/**
 * The card a `TOG-123-slug` head branch names, whatever its status or assignee: ownership first, eligibility
 * (status, assignee, blockers) is checked on the owner afterwards (waker.ts), so an ineligible owner holds the wake
 * instead of handing it to another card.
 */
export const CARD_BY_IDENTIFIER_SQL = `select i.id, i.identifier, i.status, i.assignee_agent_id
from public.issues i
where i.company_id = $1 and i.identifier = $2
limit 1`;

/**
 * The card whose own assignee first posted this exact PR URL (the authoring card), whatever its status. Comments by
 * excluded agents (the Reviewer) and chat-channel cards never establish ownership.
 * Interim until plugins can read issue_work_products; see README "Card resolution".
 */
export const CARD_BY_COMMENT_SQL = `select i.id, i.identifier, i.status, i.assignee_agent_id, min(c.created_at) as first_mention
from public.issues i
join public.issue_comments c on c.issue_id = i.id
where i.company_id = $1
and i.assignee_agent_id is not null and not (i.assignee_agent_id::text = any(string_to_array($4, ',')))
and i.origin_kind is distinct from 'chat_channel'
and c.company_id = $1 and c.author_agent_id = i.assignee_agent_id and c.deleted_at is null
and c.body ilike $2 and c.body ~* $3
group by i.id, i.identifier, i.status, i.assignee_agent_id
order by first_mention asc
limit 1`;

/** The evidence comment is already on the card (posted, but the phase mark was lost). */
export const COMMENT_EXISTS_SQL = `select c.id
from public.issue_comments c
where c.company_id = $1 and c.issue_id = $2 and c.body = $3 and c.deleted_at is null
limit 1`;

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** `github.com/org/repo/pull/12` matched case-insensitively, never `/pull/123`. */
export function prUrlPatterns(repo: string, number: number): { like: string; regex: string } {
  const tail = `github.com/${repo}/pull/${number}`;
  return { like: `%${escapeLike(tail)}%`, regex: `${escapeRegex(tail)}([^0-9]|$)` };
}
