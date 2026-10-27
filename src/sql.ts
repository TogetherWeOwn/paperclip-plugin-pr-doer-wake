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

export function recordOutcomeSql(ns: string): string {
  return `update ${ns}.wake_ledger set outcome = $3, issue_id = $4, attempts = attempts + 1, updated_at = now()
where company_id = $1 and fingerprint = $2`;
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

export const MAX_ATTEMPTS = 5;

/**
 * Rows the sweep finishes: transient errors after 2 minutes, rows still at 'claimed' after 10 minutes (the worker
 * stopped between claim and outcome), and rows without a resolvable owning card yet (the doer's PR-link comment
 * often lands after a fast check) with a growing backoff of 5, 10, 15, 20 minutes. All bounded by MAX_ATTEMPTS.
 */
export function retryableSql(ns: string): string {
  return `select fingerprint, signal::text as signal, issue_id::text as issue_id,
comment_posted_at::text as comment_posted_at, wake_attempted_at::text as wake_attempted_at
from ${ns}.wake_ledger
where company_id = $1 and attempts < ${MAX_ATTEMPTS} and (
(outcome = 'error' and updated_at < now() - interval '2 minutes')
or (outcome = 'claimed' and updated_at < now() - interval '10 minutes')
or (outcome = 'no_card' and updated_at < now() - interval '5 minutes' * attempts))
order by updated_at asc limit 20`;
}

export function pruneSql(ns: string): string {
  return `delete from ${ns}.wake_ledger where updated_at < now() - interval '30 days'`;
}

/** The live card a `TOG-123-slug` head branch names. */
export const CARD_BY_IDENTIFIER_SQL = `select i.id, i.identifier, i.status, i.assignee_agent_id
from public.issues i
where i.company_id = $1 and i.identifier = $2 and i.status not in ('done', 'cancelled')
and i.assignee_agent_id is not null and not (i.assignee_agent_id::text = any(string_to_array($3, ',')))
limit 1`;

/**
 * The live card whose own assignee first posted this exact PR URL (the authoring card).
 * Interim until plugins can read issue_work_products; see README "Card resolution".
 */
export const CARD_BY_COMMENT_SQL = `select i.id, i.identifier, i.status, i.assignee_agent_id, min(c.created_at) as first_mention
from public.issues i
join public.issue_comments c on c.issue_id = i.id
where i.company_id = $1 and i.status not in ('done', 'cancelled')
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
