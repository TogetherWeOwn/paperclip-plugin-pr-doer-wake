# CI wake and PR custody

CI completion wakes for explicitly registered Paperclip cards, plus separately opt-in hourly PR custody. This is the successor to PR doer wake in the same repository and package, retaining plugin ID `togetherweown.pr-doer-wake`. The CI registration path never trusts PR bodies, issue text, comments or a branch prefix to select a card. The custody job has a distinct, conservative discovery policy described below; it cannot create CI registrations or authorize a merge.

**Status: implementation pending independent Security/QA acceptance and Operator canary. Not installed or qualified by this repository.** Stock Paperclip plugin SDK only; no core modifications, internal APIs, GitHub settings changes or LLM calls are needed for phase one.

## Registration

Immediately after a push, call the plugin-contributed `ci_wait_register` tool:

```json
{
  "issueId": "aaaaaaaa-0000-4000-8000-000000000001",
  "repo": "example/project",
  "prNumber": 42,
  "headSha": "0123456789abcdef0123456789abcdef01234567"
}
```

The host supplies company, project, agent and run identity. The tool checks `ctx.issues.assertCheckoutOwner`, reads the card's execution workspace, and verifies its company, project, exact GitHub repository and exact branch against the current open PR and head SHA. Fork heads are refused. Draft PRs are allowed: explicit registration authorizes waiting for their CI, not merging them. There is **no automatic branch fallback**, so a spoofed `work/<uuid>` branch or PR-body link cannot create a wait. Other arguments, URLs, credentials and secret references are refused.

Retries in the same run return the original wait ID without extending its seven-day expiry. Another run joins an active wait. After a settled wait, a manual rerun must be registered from a **new agent run**, producing a new wait ID for that head. A repeated call from the old run cannot rearm a settled wait. Keep a card backstop monitor; a registration refusal, exhausted cap or expired wait must not strand the card.

## Readiness and delivery

The SDK job `ci-wake-poll` runs every four minutes over registered open waits. Conditional REST reads use ETag / `If-None-Match`; a 304 reuses only the corresponding successfully cached response. All pages of check runs, suites, statuses and applicable branch rules are read, with finite page, byte, time and request limits. A failed/incomplete read is pending, never green. Rate limits defer work; they do not create an LLM retry loop.

Required status-check contexts come from the **PR base branch's effective rules** plus classic branch protection, including required app identity. The latest run per name/app wins, so a queued rerun supersedes its earlier green result. All required contexts must finish before a normal pass/fail wake:

- Pass: `success`, `neutral`, `skipped`.
- Fail: `failure`, `cancelled`, `timed_out`, `action_required`, `startup_failure` (commit statuses `failure`/`error` also fail).
- Unknown conclusions and nonterminal runs remain pending.
- An active required run's suite is ambiguous: it may contain optional work or a required rerun that has not created its replacement check yet. Prompt required-only completion needs positive current-generation evidence. The plugin discovers an exactly associated Actions workflow, validates its attempt, reads every page of attempt jobs, binds terminal required jobs by exact check-run reference/name/app/suite, rereads the suite, then rereads the workflow. Matching observations and required job conclusions allow optional work in that same attempt to continue without delaying the wake.
- This is a bounded consistency check, **not a cross-resource transaction or complete list of uncreated rerun targets**. Ambiguous/newer/partial attempts, unavailable Actions access, contradictory or incomplete reads, and providers without equivalent evidence defer to later normal polls, potentially until full workflow/suite settlement. Repeated reads, 304s, timestamps, numeric ordering and debounce do not prove a missing required replacement was excluded. Legacy statuses have no suite/generation binding and wait for observed suites to settle. Universal prompt required-only latency is not promised. Expiry remains expiry, never a fabricated pass/fail.
- Without required contexts, all observed suites and latest runs/commit statuses must be terminal. An empty head remains pending; no Actions extension is applied.
- A missing required context yields a fail wake naming `required check missing` only after twice the repository CI median has elapsed since the last suite completion (registration time if no suite exists), and no present required context remains pending.

The cold-start median is an operator-supplied measured `repoMedianMs` entry, or **30 minutes** when unknown. A rolling sample of up to 31 distinct settled registered heads replaces it. The plugin measures suite creation-to-final-completion, not agent registration-to-wake latency. It never treats an HTTP denial as an absence of required checks. A moved head, changed branch, closed or merged PR retires the wait without waking. Fresh PR and card/workspace/config reads precede every wake; a concurrent GitHub change after the final read cannot be made atomic with the Paperclip wake.

The wake reason names pass/fail, repository, short head SHA, failed contexts and missing contexts. The host remains authoritative for assignee, blockers, terminal status, paused agents and budget. A host-deferred (`queued: false`) wait remains open. Exactly matched, known pre-queue accounting/not-sent refusals also remain open; unknown exceptions never authorize retry. A failed pre-dispatch intent write is restored to open when possible, because no wake call has occurred. Dry run logs **`would wake`**, records a terminal dry-run outcome and calls no wake API; switching to live does not replay dry-run completions.

### At-most-once boundary

Each `(repo, headSha, waitId)` has a durable intent before `ctx.issues.requestWakeup`, plus a stable host idempotency key. All entrypoints share a single-worker lock, including overlapping scheduled callbacks. If the host reply is lost, the wait becomes `unconfirmed` and is **not retried**; restart treats an unfinished intent the same way. This favors no duplicate requests over guaranteed delivery during an ambiguous failure. The backstop recovers missed work. Do not claim exactly-once delivery or run multiple independent plugin workers against the same ledger: stock state has no cross-worker compare-and-swap.

## Configuration and limits

The CI registration/polling path uses these capabilities:

```text
webhooks.receive  jobs.schedule  issues.read  issues.wakeup  issues.checkout
execution.workspaces.read  agent.tools.register  plugin.state.read
plugin.state.write  http.outbound  secrets.read-ref
```

CI registration discovers companies only from its own registered waits. Custody adds the explicitly listed read/create/document capabilities below, but no issue-update/comment, shell, company-enumeration or GitHub-write surface. Both credentials resolve **at call time**, remain operation-local and are never returned/logged/stored. Do not paste credential values into config; use Paperclip secret pickers.

| Config | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Master switch; rejects registrations and stops rechecks when disabled. |
| `dryRun` | `true` | Log/record would-wake decisions without waking. |
| `allowedRepos` | `[]` | Explicit owner/repo allowlist; mandatory when enabled, maximum 100. |
| `githubTokenSecretRef` | unset | Existing read-only credential reference. |
| `repoMedianMs` | `{}` | Measured cold-start repo medians in ms, 60,000–86,400,000. |
| `webhooksEnabled` | `false` | Phase-two opt-in only. |
| `webhookSecretRef` | unset | Owner-held HMAC secret reference, required only in phase two. |

Use a GitHub credential that can read pull requests, checks, statuses and effective branch rules/classic protection for allowlisted repos. Prompt same-attempt Actions reconciliation additionally needs existing **Actions: read** access to the fixed workflow-run/attempt-job endpoints; verify the actual plugin credential at qualification, not an agent's separate GitHub identity. Without that access, active-suite reconciliation defers and settled suites still use the normal checks path. Never widen a credential to avoid deferral without separate authorization. A GitHub App installation token must be maintained by its existing credential provider; this plugin does not mint tokens, rotate credentials, modify installations or increase scopes. For public repos a suitable token can read public resources; verify rules/protection access explicitly. A 401/403 is a retryable configuration/access problem, not a green result. No webhook secret is needed for polling.

Hard runtime caps: 20 simultaneous open waits across the installation; 2,000 retained waits; seven-day active TTL; 30-day dedupe tombstones; 1,000 recent safe audit entries; 240 HTTP requests / 180 seconds / 20 wake attempts per tick. Bounded per-client page and response limits may defer large heads rather than truncate results. Expiry/compaction run on the independent scheduled job, including while disabled. No cloud resources are provisioned and no paid runner is used, so provisioning/spend reservation and cloud teardown are not applicable. Operator must export required audit evidence before the bounded ring expires.

## Operator installation and canary (phase one)

1. Obtain native Security acceptance and QA for the exact source/artifact/configuration envelope; retain exact-head GitHub Actions run/job links. Complete `ACCEPTANCE.md`, including native-tool governance coverage on the target stock host. A manifest declaration is not evidence that governance ran.
2. An Operator installs/upgrades the reviewed package, preserving the plugin ID. Bind an **existing approved** read-only GitHub credential with the secret picker. Creating/rotating credentials requires the separate owner decision; this plugin does neither.
3. Replace old configuration, do not carry its heuristic fields forward. Start `enabled: true`, `dryRun: true`, allowlisting only the canary repository. Keep `webhooksEnabled: false`; no GitHub settings change is needed.
4. Register after each canary PR push. Compare the first **20 distinct registered heads** against GitHub's authoritative required contexts and timestamps. Retain per-head registration time, final-check time, poll/would-wake time, head-move retirement and wake count. Exit only with **0 premature wakes, 0 misses beyond one four-minute poll, 0 duplicate wakes**. Count ambiguity, caps, HTTP denials and failed reads explicitly; they are not passes. Sample enough checks to verify queued reruns, required missing and failed contexts, not merely all-green heads.
5. Operator records the evidence and enables live wakes only through the accepted configuration envelope. Dry-run records stay terminal; register new heads (or new-run waits after a deliberate rerun) for live evidence. Record actual live host queue/run evidence.
6. Only after canary/live acceptance, route the agent instruction change through its normal reviewer/applier: register after push and keep a long backstop `max(15 minutes, 2 × repo median)`. Do not change instructions or remove backstops merely because code merged.

Old SQL migrations remain as historical schema definitions, not active manifest migrations. Existing database evidence is neither read nor deleted. The previous `github` endpoint and check_run/pull_request subscriptions are retired; no old webhook settings are reused automatically. The Operator/owner must handle obsolete settings separately under their normal authority.

## Exact owner steps for optional webhook hints (phase two)

After phase-one acceptance, the owner who administers GitHub and holds the new secret:

1. Generate a high-entropy webhook secret privately. Do not send it to an agent, an issue, the Operator or this repository.
2. Store it directly in a Paperclip company secret. Bind its reference as `webhookSecretRef` for the reviewed plugin, using the secret picker; never a raw string.
3. In the canary GitHub repository **Settings → Webhooks → Add webhook** (later the organization **Settings → Webhooks → Add webhook**), set payload URL to `https://<your-public-paperclip-host>/api/plugins/<installed-plugin-id>/webhooks/github-ci`. Use the installed record's route identifier, not an assumed UUID. Content type **application/json**; **SSL verification enabled**; enter the same secret privately.
4. Select **Let me select individual events → Check suites only**, then **Active**. Do not select all events, check runs, pull requests or workflow runs. GitHub check-suite webhooks deliver completed events; statuses are still caught by polling.
5. Operator enables `webhooksEnabled` only after the owner confirms the webhook/secret placement. Validate one real completed check-suite delivery and its HMAC verdict, then prove the resulting read sees current GitHub state. A delivery itself is not CI completion evidence.
6. Monitor the host's webhook-delivery table/storage growth during the canary: stock host may persist raw bodies/headers before plugin verification and may not prune them. If that risk is not accepted, leave webhooks off and use polling. Protect public ingress with existing limits if authorized; this plugin cannot enforce pre-storage retention.

The plugin verifies SHA-256 HMAC over the **raw body** with `timingSafeEqual`, ignores `parsedBody`, requires delivery UUIDs, retains a 24-hour replay guard and checks repo/org against the allowlist. The event is only a hint for the same readiness recheck. Payloads are capped at 64 KiB; before any ledger/config RPC, admission is limited to two outstanding hints and six candidate bodies per minute. Verification is independently capped at six secret resolutions per minute per worker; hints are debounced 20 seconds per head and capped at six per minute. Oversized/busy hints may be dropped safely: polling remains authoritative.

## Rollback and revocation

Operator sets `dryRun: true` or `enabled: false`, disables the tool profile, and removes secret bindings if needed. The owner disables/deletes the optional webhook. Keep card backstops and reconcile `unconfirmed` waits against actual host run records; never blindly replay them. A rollback must not reinstall the unsafe ownership heuristic without a separate decision. Do not delete the state ledger to retry a wake. Review threats and residual host limits in [THREAT-MODEL.md](THREAT-MODEL.md).

## Hourly PR custody (separate opt-in)

`pr-custody` runs at `17 * * * *` without an LLM. It inventories every **credential-visible** non-archived repository in one configured organization, using fully paginated REST repository/pulls listings, never search. All open PRs are read. Closed PRs are read by descending update time back to an inclusive stored cursor, including PRs opened and closed between ticks. On first use the Operator must explicitly choose `custodyClosedSince`; no coverage before that boundary is claimed. Partial, denied, malformed or over-cap evidence is **UNKNOWN**, never a zero count or absence of ownership.

### Configuration

Custody is independent of `enabled`, `dryRun` and the CI registration `allowedRepos`:

| Config | Default | Meaning |
| --- | --- | --- |
| `custodyEnabled` | `false` | Opt in to the hourly job. |
| `custodyDryRun` | `true` | State/report/log only; no card, document or wake effects. |
| `custodyCompanyId` | unset | Exactly one company's card evidence and native effects. |
| `custodyOrg` | unset | Exact GitHub organization; all its visible non-archived repos. |
| `custodySummaryAgentId` | unset | Accountable recipient of the daily unmapped/bot summary and unassigned-source follow-ups. |
| `custodyClosedSince` | unset | Required initial closed-inventory boundary, `YYYY-MM-DDTHH:mm:ssZ`. |
| `githubTokenSecretRef` | unset | Existing approved read credential; resolved only for the tick. |

The new manifest capabilities are `issues.create`, `issue.documents.read`, `issue.documents.write`, `issue.relations.read`, `projects.read`, `project.workspaces.read`, `database.namespace.read` and `database.namespace.migrate`. The last capability is required by the stock schema for **any** database declaration, including read-only access. `custody-migrations` contains no SQL; historical migrations are not activated. Only `issues`, `issue_comments` and `issue_documents` are core-read tables. Document bodies use the supported SDK, not an undeclared join. No `issues.update`, comment creation, core SQL write or work-product mutation is granted.

### Mapping and triggers

Use the first nonempty mapping tier: explicit ci-wake registration; exact `work/<uuid>` head with a company card and project-repo match; an exact PR URL token in card title/description, agent comments or documents; then tracker-identifier branch plus project-repo match. Branch tiers require a same-repository head, never a fork prefix. Multiple candidates at the winning tier, or no candidates, are UNMAPPED; never select a primary owner. All card states and unrelated plugin/routine origins participate. The job excludes its own generated custody cards/documents so its output cannot become ownership or disposition evidence. Work-product mapping is not implemented because the pinned SDK has no read API; the existing upstream [work-product read proposal](https://github.com/paperclipai/paperclip/issues/17887) tracks this gap. Any SDK contribution is a separately gated follow-up, not an invented table grant or a duplicate issue.

Triggers:

- Open PR idle for seven days since the latest push/head observation, commit, submitted review, head check-suite update, or PR-specific `PR disposition:` line. A latest `defer` with a future UTC revisit date suppresses idle. Holds must be recorded as such a defer; unrelated PR directives do not count. `finish` lines become stale again after seven days.
- Open PR on a `done`, `cancelled` or `backlog` card. Stable card/status-version identity defines the epoch, not document writes or generic `updatedAt` churn.
- Closed unmerged PR missing a `Closed unmerged:` line on **either** the mapped card or the PR. The card line must identify this PR by repository/number or exact URL. A valid superseded closure is not reopened.

GitHub's GraphQL `Commit.pushedDate` is deprecated and may be null. Commit author/committer dates do **not** prove push time, and PR metadata `updatedAt` is not used as a substitute. The job persists first observation of each head and resets it on SHA changes. This is a conservative upper bound: newly observed heads receive a seven-day warmup before idle can fire. Later review/check/disposition activity extends the epoch. Unknown/missing activity still blocks idle, but cannot erase an independently proven terminal-card trigger. This warmup is a documented coverage/latency limit, not a claim of historical push evidence.

### Effects, state and recovery

Keys are `repo#number|kind|epoch`; the same key is the wake idempotency key and any created child's `originId`. For an assigned, unblocked `todo`/`in_progress`/`in_review` card, append bounded PR/head/trigger evidence to its `pr-custody` document and explicitly request a native wake. Otherwise create a `todo` child assigned to the source's agent (configured summary recipient when absent), save evidence, then explicitly request the wake. Creation alone does not wake. Current config, card assignment/status/blockers and PR head/state are rechecked before dispatch; the host remains authoritative for its native run/budget gates. No task status, review policy, PR, branch or work product is modified.

At most **15 trigger effects per tick**, oldest first across repos, including uncertain creation attempts. Unmapped and bot PRs go into one daily summary card, not one card per PR. Its document accumulates observed items for the day; its wake is requested once. No comments are posted. A fresh PR-specific disposition acknowledges a previously observed terminal trigger; closure rationale is still required on both sides.

Durable creation/wake intent precedes each effect. Restart/ambiguous wake replies are `unconfirmed` and never replayed automatically; a possibly created card can only be recovered by its exact origin. `queued: false` is positive no-dispatch evidence and may retry. Preserve existing backstops and inspect unconfirmed records manually. One worker only: plugin state has no distributed CAS. Live and dry-run state are separate so promotion cannot consume live dedupe keys or skip the initial live closure inventory. Closed cursors do not advance past undispatched/deferred closures or failed summaries.

State namespace `pr-custody-v1`, company scope, key `<org>:dry` or `<org>:live` stores cursor/receipt/head observations, a latest inventory report, and 1,000 safe audit records retained at most 30 days. Reports project only PR identifiers, card IDs, mapping source, trigger keys and UNKNOWN scopes, never raw API/card bodies or credentials. Receipt tombstones are bounded at 20,000 and never automatically forgotten while an old trigger could recur; exhaustion fails closed for new effects. Head observations are bounded at 10,000. Per tick: 1,200 attempted HTTP requests, 20,000 host-read admissions and four minutes. Card snapshot caps are 20,000 cards, 100,000 comments, 10,000 documents and 64 MiB text; per-body limits and HTTP page/byte/cache/time limits also apply. These are refusal budgets, never silent truncation. No cloud resources or spend reservations exist, so TTL/auto-teardown of provider resources is not applicable.

### Custody rollout gate

1. Native Security sign-off on exact source/artifact, expanded capabilities, core-read/privacy boundary, GitHub grant, single-worker state and host transport; then QA using exact-head Actions evidence.
2. Operator installs the reviewed package with custody disabled, binds the existing approved credential, chooses the one company/org/summary recipient and initial closure boundary, then enables **dry run first**. Creating/rotating/widening a credential is a separate authority decision.
3. Compare the saved inventory against a manual REST inventory of every non-archived repo and every open PR, plus the chosen closed boundary. Require zero omitted repos/PRs, no false owner/primary-owner choice, correct mapped/unmapped/bot classifications, zero duplicate effects, no premature idle wake, and correct closed-between-ticks/rationale handling. UNKNOWN evidence and head warmup are explicit incomplete qualification, not passes.
4. Reconcile the existing detector so it cannot duplicate disposition asks; retain only its work-product-label repair responsibility. Operator enables live only in the accepted envelope and records actual native wake receipts.
5. Only after live adoption, queue the Detection-rule replacement through its existing instruction reviewer and configuration window. Source merge is not installation, live acceptance, or permission to replace operational rules.

Rollback: Operator disables `custodyEnabled` (or sets `custodyDryRun: true`) and preserves state/backstops. Do not delete tombstones to retry an ambiguous effect, reinstall old guessing behavior, or automatically close/reopen PRs. Existing CI configuration can remain independent.

## Development

Pinned SDK fixture target: `@paperclipai/plugin-sdk@2026.1023.0` (lockfile). GitHub REST API version `2022-11-28`. Tests use synthetic fixtures and no live provider calls. GitHub Actions is the CI of record: the `check` job runs locked dependency installation, typecheck, Vitest and build on a standard hosted runner. Push a draft PR and record the exact head's run/job links. Do not run a full suite or CI mirror on a shared host. Before pushing, run the existing bounded formatter/linter, project typecheck and changed/covering unit files, recording commands, scope, elapsed time, results and justified skips separately from exact-head Actions evidence.
