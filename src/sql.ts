/**
 * Every statement this plugin sends through ctx.db. Tests run each one through a verbatim copy of the
 * host validators (/app/server/src/services/plugin-database.ts validatePluginRuntimeQuery/Execute).
 * Core reads use only manifest coreReadTables `issues` and `issue_comments`
 * (PLUGIN_DATABASE_CORE_READ_TABLES in packages/shared/src/constants.ts:1442).
 */
/**
 * $8 is this attempt's claim token, written as created_at: with `attempts` it names the claim incarnation that every
 * later write of the attempt is fenced on (CLAIM_FENCE). A row forgotten and claimed again gets a new created_at, so
 * an attempt that stalled on the old row can never write to the new one.
 */
export function claimSql(ns: string): string {
  return `insert into ${ns}.wake_ledger (company_id, fingerprint, repo, pull_number, head_sha, state, signal, created_at)
values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz) on conflict do nothing`;
}

/**
 * The claim incarnation an attempt holds: the row's created_at (set at claim) and its `attempts` (bumped by every
 * re-claim, reclaimSql). An attempt that stalled while the sweep re-claimed its row, or forgot it and a new signal
 * claimed it again, matches nothing and changes nothing: it can neither post a phase, record an outcome over a newer
 * decision (a hold such as ambiguous_card), nor mark the wake. touchSql changes neither column, so a signal folded
 * into an attempt does not stop it. Appended to every write of an attempt as the last two parameters.
 */
function claimFence(first: number): string {
  return `created_at = $${first}::timestamptz and attempts = $${first + 1}`;
}

/** What a retry needs from a ledger row (sweep and redelivery alike). */
const ROW_COLUMNS = `fingerprint, outcome, attempts, created_at::text as created_at, updated_at::text as updated_at, signal::text as signal,
issue_id::text as issue_id, comment_posted_at::text as comment_posted_at, wake_attempted_at::text as wake_attempted_at`;

/**
 * Pre-check before any GitHub lookup: a row that already woke (or may have) makes the signal a duplicate at no
 * cost; a pending row whose wake was never attempted is resumed at once, and a row in flight takes the signal over
 * (touchSql; plugin.ts processSignal). The claim stays the atomic gate.
 */
export function seenSql(ns: string): string {
  return `select ${ROW_COLUMNS} from ${ns}.wake_ledger where company_id = $1 and fingerprint = $2`;
}

/** Outcome of the attempt that holds the row ($5, $6: its claim, claimFence). rowCount 0: superseded. */
export function recordOutcomeSql(ns: string): string {
  return `update ${ns}.wake_ledger set outcome = $3, issue_id = $4, updated_at = now()
where company_id = $1 and fingerprint = $2 and ${claimFence(5)}`;
}

/**
 * A retry takes a row only if nobody changed it since the select ($3 outcome, $4 updated_at as text): rowCount 1
 * means this attempt owns the retry, 0 means another one got there first. $5 is this attempt's own claim token,
 * written as updated_at: forgetSql deletes the row only while it still carries it (see touchSql).
 */
export function reclaimSql(ns: string): string {
  return `update ${ns}.wake_ledger set outcome = 'retrying', attempts = attempts + 1, updated_at = $5::timestamptz
where company_id = $1 and fingerprint = $2 and outcome = $3 and updated_at::text = $4`;
}

/**
 * A signal for a fingerprint whose attempt is in flight (claimed or retrying, wake not requested) is folded into
 * that attempt instead of being dropped as a duplicate: the newest signal ($3) is stored and updated_at moves by one
 * microsecond, which voids the attempt's claim token. If that attempt then finds nothing to wake on its (possibly
 * older) GitHub snapshot, its forgetSql matches nothing and it keeps the row pending for the sweep to re-read.
 * No new column: updated_at is the row version. rowCount 0: the row is no longer in flight (look again).
 */
export function touchSql(ns: string): string {
  return `update ${ns}.wake_ledger set signal = $3::jsonb, updated_at = updated_at + interval '1 microsecond'
where company_id = $1 and fingerprint = $2 and wake_attempted_at is null and outcome in ('claimed', 'retrying')`;
}

/** Phase marks: what a retry must not repeat (migrations/002_wake_phases.sql). $4, $5: the claim (claimFence). */
export function markCommentPostedSql(ns: string): string {
  return `update ${ns}.wake_ledger set comment_posted_at = now(), issue_id = $3, updated_at = now()
where company_id = $1 and fingerprint = $2 and ${claimFence(4)}`;
}

/**
 * The atomic gate right before requestWakeup: rowCount 1 only for the attempt that still holds the row's current
 * claim ($5, $6, claimFence) and only if no wake was marked yet. An attempt that stalled past the 10-minute stuck
 * window while another one took its row (and woke, held it, or forgot it after a skip) gets 0 and never requests the
 * wake. $4 is this attempt's own mark value.
 */
export function markWakeAttemptedSql(ns: string): string {
  return `update ${ns}.wake_ledger set wake_attempted_at = $4::timestamptz, issue_id = $3, updated_at = now()
where company_id = $1 and fingerprint = $2 and wake_attempted_at is null and ${claimFence(5)}`;
}

/**
 * Undo this attempt's own wake mark ($3, the value it set) when requestWakeup provably never reached the host (the
 * mark's own DB reply was lost before the call, or the host refused before queueing anything) and record $4: `error`
 * for the sweep to retry, or `refused:<message>`, which only a later genuine signal resumes (plugin.ts resumable).
 * Never clears another attempt's mark.
 */
export function releaseWakeAttemptSql(ns: string): string {
  return `update ${ns}.wake_ledger set wake_attempted_at = null, outcome = $4, updated_at = now()
where company_id = $1 and fingerprint = $2 and wake_attempted_at = $3::timestamptz`;
}

/**
 * Rows the sweep finishes: transient errors (GitHub down, secret refused) and rows without a resolvable or eligible
 * owning card yet (the doer's PR-link comment often lands after a fast check; the owner may be with the Reviewer)
 * with an exponential backoff of 2, 4, 8, 16, 32, then 60 minutes; and rows still at 'claimed' or 'retrying' after
 * 10 minutes (the worker stopped mid-attempt). Errors have no attempt cap: such a row ends only when a retry decides
 * it (woken, held, or forgotten because GitHub says the PR no longer qualifies), so an outage never loses a signal.
 * A `no_card` row is polled for NO_CARD_RETRY_ATTEMPTS re-claims (about 4 hours) and then kept for a later genuine
 * signal to resume (plugin.ts resumable): a PR no card owns (opened by a person) would otherwise cost a full owner
 * scan every hour for as long as it stays open.
 * The exponent is capped as well, since power(2, n) overflows float8 past n ~ 1023. A row without a signal (a
 * settled tombstone, or a pending row an earlier build compacted, which only a redelivery can resume) is skipped.
 * Each row is then taken with reclaimSql.
 */
export const NO_CARD_RETRY_ATTEMPTS = 8;

export function retryableSql(ns: string): string {
  return `select ${ROW_COLUMNS}
from ${ns}.wake_ledger
where company_id = $1 and signal <> '{}'::jsonb and (
((outcome = 'error' or (outcome = 'no_card' and attempts < ${NO_CARD_RETRY_ATTEMPTS}))
and updated_at < now() - interval '1 minute' * least(power(2, least(attempts, 5) + 1), 60))
or (outcome in ('claimed', 'retrying') and updated_at < now() - interval '10 minutes'))
order by updated_at asc limit 20`;
}

/**
 * Drop a row whose wake was never requested: a skip that is not final for the fingerprint (check not red yet,
 * draft, not conflicting, repo stopped). A later genuine signal on the same head and state can then
 * claim it again. A row whose wake may have reached the host is never deleted (at most once), nor one that a newer
 * signal touched (touchSql) or another attempt took since this attempt's claim ($3, its reclaimSql token).
 */
export function forgetSql(ns: string): string {
  return `delete from ${ns}.wake_ledger
where company_id = $1 and fingerprint = $2 and wake_attempted_at is null and updated_at = $3::timestamptz`;
}

/**
 * Outcomes the sweep never retries (the part before any `:`), so their signal payload is not needed: a woken or
 * possibly woken row (woken, wake_unconfirmed), a fail-closed decision (ambiguous_card, shadow), and a never-woken
 * hold on the card (held_status, held_blockers, refused), which only a later genuine signal resumes, with its own
 * payload (plugin.ts resumable). Every other row is pending (claimed, retrying, error, no_card, an earlier build's
 * stale:<reason>) and still needs its signal.
 */
export const SETTLED_OUTCOMES = ["woken", "wake_unconfirmed", "refused", "held_status", "held_blockers", "ambiguous_card", "shadow"] as const;

/**
 * Retention: 30 days after a row was settled it keeps only its dedupe key and outcome (a tombstone of a few hundred
 * bytes); the signal payload is dropped. A pending row is never compacted, however old (for example of a company
 * disabled for a month): its signal is what a retry wakes with. Rows are never deleted: a still-open PR on the same
 * head in the same state would otherwise wake again (for example a later default-branch push re-sweeping a conflict).
 */
export function compactSql(ns: string): string {
  return `update ${ns}.wake_ledger set signal = '{}'::jsonb
where updated_at < now() - interval '30 days' and signal <> '{}'::jsonb
and split_part(outcome, ':', 1) in (${SETTLED_OUTCOMES.map((o) => `'${o}'`).join(", ")})`;
}

/**
 * The card a `TOG-123-slug` head branch names, whatever its status or assignee: ownership first, eligibility
 * (status, assignee, blockers) is checked on the owner afterwards (waker.ts), so an ineligible owner holds the wake
 * instead of handing it to another card. project_id: the branch counts only if that project has a workspace for the
 * PR's repo (waker.ts resolveCard).
 */
export const CARD_BY_IDENTIFIER_SQL = `select i.id, i.identifier, i.status, i.assignee_agent_id, i.project_id::text as project_id
from public.issues i
where i.company_id = $1 and i.identifier = $2
limit 1`;

/**
 * Up to two distinct cards on which an agent posted this exact PR URL (the doer's PR-link comment), whatever the
 * card's status or CURRENT assignee. Two rows mean ownership is ambiguous and the wake is held (waker.ts
 * resolveCard): neither the first nor the latest mention proves ownership. Comments by excluded agents (the
 * Reviewer), by people and by plugins (no author agent) and chat-channel cards never count. Eligibility is checked
 * on the owner afterwards. Interim until plugins can read issue_work_products; see README "Card resolution".
 */
export const CARD_BY_COMMENT_SQL = `select i.id, i.identifier, i.status
from public.issues i
join public.issue_comments c on c.issue_id = i.id
where i.company_id = $1 and i.origin_kind is distinct from 'chat_channel'
and c.company_id = $1 and c.deleted_at is null
and c.author_agent_id is not null and not (c.author_agent_id::text = any(string_to_array($4, ',')))
and c.body ilike $2 and c.body ~* $3
group by i.id, i.identifier, i.status
order by i.id
limit 2`;

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

/**
 * Where a PR URL may start to count as ownership evidence: at the start of the text, after whitespace, after `<`
 * (an autolink) or as a markdown link target `](`. Anything else (`=`, `?`, `&`, a bare `(`, `/`, a letter) can put the
 * GitHub URL inside another host's URL (`https://evil.io/?u=(https://github.com/...)`), so it never counts: fail
 * closed. An allow-list, not a deny-list of URL characters. Valid in JS and Postgres ARE alike.
 */
const URL_TOKEN_START = "(^|\\s|<|\\]\\()";

/**
 * The PR URL as ownership evidence: an actual `https://github.com/<org>/<repo>/pull/<n>` link, case-insensitive,
 * that starts a token (never inside another URL or on another host such as `notgithub.com`) and ends at a
 * non-digit (never `/pull/<n>3`). The LIKE pattern pins scheme and host; the regex adds both boundaries.
 */
export function prUrlPatterns(repo: string, number: number): { like: string; regex: string } {
  const url = `https://github.com/${repo}/pull/${number}`;
  return { like: `%${escapeLike(url)}%`, regex: `${URL_TOKEN_START}${escapeRegex(url)}([^0-9]|$)` };
}

/** Clear only never-attempted state: wake marks remain permanent dedupe tombstones. */
export function clearClosedSql(ns: string): string {
  return `delete from ${ns}.wake_ledger where company_id = $1 and repo = $2 and pull_number = $3 and wake_attempted_at is null`;
}
