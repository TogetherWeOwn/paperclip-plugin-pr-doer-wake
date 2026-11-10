# CI wake

CI completion wakes for explicitly registered Paperclip cards. This is the successor to PR doer wake in the same repository and package, retaining plugin ID `togetherweown.pr-doer-wake`. Version 0.2 replaces the old ownership guessing, check-failure/conflict triggers, core-table reads and SQL ledger. It never trusts PR bodies, issue text, comments or a branch prefix to select a card.

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

Each `(repo, headSha, waitId)` has a durable intent before `ctx.issues.requestWakeup`, plus a stable correlation/idempotency key. The reported target host does **not** deduplicate that key: the plugin ledger, not host deduplication, prevents repeat dispatch. All entrypoints share a single-worker lock, including overlapping scheduled callbacks. If the host reply is lost, the wait becomes `unconfirmed` and is **not retried**; restart treats an unfinished intent the same way. This favors no duplicate requests over guaranteed delivery during an ambiguous failure. The backstop recovers missed work. Do not claim exactly-once delivery or run multiple independent plugin workers against the same ledger: stock state has no cross-worker compare-and-swap.

## Configuration and limits

The manifest has only these capabilities:

```text
webhooks.receive  jobs.schedule  issues.read  issues.wakeup  issues.checkout
execution.workspaces.read  agent.tools.register  plugin.state.read
plugin.state.write  http.outbound  secrets.read-ref
```

No issue creation/update/comments, company/project enumeration, SQL namespace, shell or GitHub resource writes. App mode adds only the fixed installation-token exchange below. The tool discovers companies only from its own registered waits. Secret references resolve **at call time**; key material, JWTs and tokens are never returned/logged/stored in plugin state. Do not paste credential values into config; use Paperclip secret pickers.

| Config | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Master switch; rejects registrations and stops rechecks when disabled. |
| `dryRun` | `true` | Log/record would-wake decisions without waking. |
| `allowedRepos` | `[]` | Explicit owner/repo allowlist; mandatory when enabled, maximum 100. |
| `githubTokenSecretRef` | unset | Bearer mode: existing read-only token reference. Do not configure any App field with this. |
| `githubAppId` | unset | App mode: numeric App ID, as a positive decimal string. |
| `githubInstallationId` | unset | App mode: existing authorized installation ID, as a positive decimal string. |
| `githubAppPrivateKeySecretRef` | unset | App mode: existing approved RSA private-key reference; requires both IDs and excludes bearer mode. |
| `repoMedianMs` | `{}` | Measured cold-start repo medians in ms, 60,000–86,400,000. |
| `webhooksEnabled` | `false` | Phase-two opt-in only. |
| `webhookSecretRef` | unset | Owner-held HMAC secret reference, required only in phase two. |

Configure **exactly one** complete mode. Partial App configuration, mixing App and bearer fields, raw keys/tokens and unknown fields fail closed, including while disabled. Existing bearer configurations remain compatible. No webhook secret is needed for polling.

### GitHub App exchange

App mode signs an RS256 JWT with the configured App ID, `iat = now − 60s`, `exp = now + 300s`, using an RSA private key of 2048–8192 bits resolved through `ctx.secrets.resolve`. It sends only `POST https://api.github.com/app/installations/{installationId}/access_tokens` through the stock SDK HTTP client, with explicit `repositories: [repositoryName]` and these fixed permissions:

| GitHub permission key | Used for |
| --- | --- |
| `pull_requests: read` | Current PR/head/base/branch identity |
| `checks: read` | Check runs and suites |
| `statuses: read` | Commit status history (`commit_statuses` is not a valid App permission key) |
| `actions: read` | Workflow runs and attempt-specific jobs |
| `administration: read` | Classic branch protection required-status-check settings |
| `metadata: read` | Implicit GitHub metadata permission; effective branch rules |

The [GitHub permission reference](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps) and [installation-token API](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app) define these scopes. These are requested permissions, **not evidence the App has them**. Public repositories do not prove protection/Actions access. An installation not covering the repository, missing grants, expired/revoked credentials or an unexpected envelope blocks the read. There is no bearer, anonymous, broader-permission or all-repository fallback. The response must identify exactly the requested owner/repository, only requested read permissions (plus implicit metadata), and expiry 60s–61min ahead. Denied exchanges never become readiness evidence.

Only the installation token is reused, in private memory for one bounded poll cycle (at most 180s); concurrent requests share one exchange. Registration and signed-hint rechecks use the same auth code with fresh cycles. Tokens renew if within 60s of expiry; a failed renewal or 401 ends their use in that cycle. App IDs, installation and key references remain operator configuration, never agent arguments. Each exchange consumes the same request/deadline/backoff budgets as reads; installation backoff spans repositories, companies sharing that installation and private-key reference rotation. Backoff is kept separately from company-isolated response caches, so their eviction cannot discard a live throttle; at capacity, new credential identities are refused rather than evicting throttles. Token responses are never ETag-cached. The exchange response acceptance cap is 16 KiB, **not a host streaming cap**.

GitHub-issued tokens expire upstream after about one hour; this plugin discards them after the cycle but does **not** revoke them or shorten GitHub's TTL. Crashes/ambiguous mint replies can therefore leave an unused token valid until expiry. Local references/garbage collection are not cryptographic memory erasure. A compromised worker with the App private key can exceed these requested scopes: Security must independently disposition that ceiling, host buffering/cancellation/trace behavior and the token-lifecycle residuals before installation. Creating/rotating credentials, changing App permissions/repositories, placing secrets or installing/enabling the plugin remain separately authorized actions.

Bearer mode uses an existing approved read-only token. Prompt same-attempt reconciliation needs **Actions: read**; without it, active-suite evidence defers conservatively until settlement. App mode intentionally requests the fixed complete read envelope above and never retries with fewer or broader scopes. Verify the actual plugin credential rather than an agent's separate GitHub identity.

Hard runtime caps: 20 simultaneous open waits across the installation; 2,000 retained waits; seven-day active TTL; 30-day dedupe tombstones; 1,000 recent safe audit entries; 240 HTTP requests / 180 seconds / 20 wake attempts per tick. Bounded per-client page and response limits may defer large heads rather than truncate results. Expiry/compaction run on the independent scheduled job, including while disabled. No cloud resources are provisioned and no paid runner is used, so provisioning/spend reservation and cloud teardown are not applicable. Operator must export required audit evidence before the bounded ring expires.

## Operator installation and canary (phase one)

1. Obtain native Security acceptance and QA for the exact source/artifact/configuration envelope; retain exact-head GitHub Actions run/job links. Complete `ACCEPTANCE.md`, including native-tool governance coverage on the target stock host. A manifest declaration is not evidence that governance ran.
2. An Operator installs/upgrades the reviewed package, preserving the plugin ID. Configure either an **existing approved** read-only bearer reference or an existing approved App ID/installation/private-key reference with the secret picker. The App installation must already cover the canary repository and requested read permissions. Creating/rotating keys, adding repositories or increasing App grants requires separate owner authorization and authorized administrative work; source merge grants none of it.
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

## Development

SDK fixture targets: locked `@paperclipai/plugin-sdk@2026.1023.0` and an isolated exact `2026.1106.0` Actions compatibility job (SDK plus shared package version asserted). `tests/ci-sdk.test.ts` runs through the installed SDK's actual RPC Response wrapper, including App POST and conditional 304 recovery; it does not prove actual host transport, governance, buffering, cancellation or trace hygiene. GitHub REST API version `2022-11-28`. Tests use synthetic fixtures and no live provider calls. GitHub Actions is the CI of record: the `check` job runs locked dependency installation, typecheck, Vitest and build on a standard hosted runner. Push a draft PR and record the exact head's run/job links. Do not run a full suite or CI mirror on a shared host. Before pushing, run the existing bounded formatter/linter, project typecheck and changed/covering unit files, recording commands, scope, elapsed time, results and justified skips separately from exact-head Actions evidence.
