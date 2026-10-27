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

/** What a retry needs from a ledger row (sweep and redelivery alike). */
const ROW_COLUMNS = `fingerprint, outcome, attempts, updated_at::text as updated_at, signal::text as signal, issue_id::text as issue_id,
comment_posted_at::text as comment_posted_at, wake_attempted_at::text as wake_attempted_at`;

/**
 * Pre-check before any GitHub lookup: a row that already woke (or may have) makes the signal a duplicate at no
 * cost; a row whose wake was never attempted is resumed at once (plugin.ts). The claim stays the atomic gate.
 */
export function seenSql(ns: string): string {
  return `select ${ROW_COLUMNS} from ${ns}.wake_ledger where company_id = $1 and fingerprint = $2`;
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

/**
 * The atomic gate right before requestWakeup: rowCount 1 only for the first attempt that marks the row. An attempt
 * that stalled past the 10-minute stuck window while another one took its row (and woke, or forgot the row after a
 * skip) gets 0 and never requests the wake. $4 is this attempt's own mark value.
 */
export function markWakeAttemptedSql(ns: string): string {
  return `update ${ns}.wake_ledger set wake_attempted_at = $4::timestamptz, issue_id = $3, updated_at = now()
where company_id = $1 and fingerprint = $2 and wake_attempted_at is null`;
}

/**
 * Undo this attempt's own wake mark ($3, the value it set) when requestWakeup provably never reached the host (the
 * mark's own DB reply was lost before the call, or the host refused before dispatch), so the sweep may retry it
 * instead of closing it unconfirmed. Never clears another attempt's mark.
 */
export function releaseWakeAttemptSql(ns: string): string {
  return `update ${ns}.wake_ledger set wake_attempted_at = null, outcome = 'error', updated_at = now()
where company_id = $1 and fingerprint = $2 and wake_attempted_at = $3::timestamptz`;
}

/**
 * Retries per row (sweep and redelivery). With the backoff below the last one runs about 8 hours after the first
 * failure; a row selected again after that is forgotten (forgetSql), never left to block a later signal.
 */
export const MAX_RETRIES = 12;

/**
 * Rows the sweep finishes: transient errors (GitHub down, secret refused) and rows without a resolvable or eligible
 * owning card yet (the doer's PR-link comment often lands after a fast check; the owner may be with the Reviewer)
 * with an exponential backoff of 2, 4, 8, 16, 32, then 60 minutes; and rows still at 'claimed' or 'retrying' after
 * 10 minutes (the worker stopped mid-attempt). Compacted tombstones (compactSql) are never retried. Each row is then
 * taken with reclaimSql.
 */
export function retryableSql(ns: string): string {
  return `select ${ROW_COLUMNS}
from ${ns}.wake_ledger
where company_id = $1 and signal <> '{}'::jsonb and (
(outcome in ('error', 'no_card') and updated_at < now() - interval '1 minute' * least(power(2, attempts + 1), 60))
or (outcome in ('claimed', 'retrying') and updated_at < now() - interval '10 minutes'))
order by updated_at asc limit 20`;
}

/**
 * Drop a row whose wake was never requested: a skip that is not final for the fingerprint (check not red yet,
 * draft, not conflicting), or a spent retry budget. A later genuine signal on the same head and state can then
 * claim it again. A row whose wake may have reached the host is never deleted (at most once).
 */
export function forgetSql(ns: string): string {
  return `delete from ${ns}.wake_ledger
where company_id = $1 and fingerprint = $2 and wake_attempted_at is null`;
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
 * The card on which an agent first posted this exact PR URL (the doer's PR-link comment), whatever the card's status
 * or CURRENT assignee: ownership must not move when the owner is handed to the Reviewer, or a later card that merely
 * mentioned the PR would be promoted. Comments by excluded agents (the Reviewer), by people and by plugins (no
 * author agent) and chat-channel cards never establish ownership. Eligibility is checked on the owner afterwards.
 * Interim until plugins can read issue_work_products; see README "Card resolution".
 */
export const CARD_BY_COMMENT_SQL = `select i.id, i.identifier, i.status, min(c.created_at) as first_mention
from public.issues i
join public.issue_comments c on c.issue_id = i.id
where i.company_id = $1 and i.origin_kind is distinct from 'chat_channel'
and c.company_id = $1 and c.deleted_at is null
and c.author_agent_id is not null and not (c.author_agent_id::text = any(string_to_array($4, ',')))
and c.body ilike $2 and c.body ~* $3
group by i.id, i.identifier, i.status
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
