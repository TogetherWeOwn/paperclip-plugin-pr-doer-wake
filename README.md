# CI wake and PR custody

CI completion wakes for explicitly registered Paperclip cards, plus separately opt-in hourly PR custody. This is the successor to PR doer wake in the same repository and package, retaining plugin ID `togetherweown.pr-doer-wake`. The CI registration path never trusts PR bodies, issue text, comments or a branch prefix to select a card. The custody job has a distinct, conservative discovery policy described below; it cannot create CI registrations or authorize a merge.

**Status: implementation pending independent Security/QA acceptance, exact-artifact/host/configuration Security sign-off and applicable production authorization before Operator installation. Not installed or qualified by this repository.** Stock Paperclip plugin SDK only; no core modifications, internal APIs, GitHub settings changes or LLM calls are needed for phase one.

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

The host supplies company, project, agent and run identity. The tool checks `ctx.issues.assertCheckoutOwner`, reads the card's execution workspace, and binds by PR number plus the exact head SHA from the workspace checkout: the live PR must be open, unmerged, on the allowlisted repository, and at exactly that SHA. The PR head branch need not equal the Paperclip workspace branch name — agents push from `work/<uuid>` checkouts to the PR head branch — so branch-name equality is never a binding criterion. Fork heads are refused. Draft PRs are allowed: explicit registration authorizes waiting for their CI, not merging them. There is **no automatic branch fallback**, so a spoofed `work/<uuid>` branch or PR-body link cannot create a wait. Every refusal returns an enumerated, secret-free code (for example `checkout_refused`, `pr_binding_refused`, `github_auth`); host detail, upstream bodies and error text never cross into agent output, except a refused token-exchange 403, where a bounded sanitized diagnostic (a fixed refusal class plus a truncated GitHub refusal message) crosses into the refusal reason and the audit detail so an installation-wide mint failure names its decider; credential-shaped text never crosses. Other arguments, URLs, credentials and secret references are refused.

Retries in the same run return the original wait ID without extending its seven-day expiry. Another run joins an active wait. After a settled wait, a manual rerun must be registered from a **new agent run**, producing a new wait ID for that head. A repeated call from the old run cannot rearm a settled wait. Keep a card backstop monitor; a registration refusal, exhausted cap or expired wait must not strand the card.

## Readiness and delivery

The SDK job `ci-wake-poll` runs every fifteen minutes as a **backstop** over registered open waits; signed webhook deliveries (phase two below) are the primary trigger so agents only run when CI has actually settled. Conditional REST reads use ETag / `If-None-Match`; a 304 reuses only the corresponding successfully cached response. All pages of check runs, suites, statuses and applicable branch rules are read, with finite page, byte, time and request limits. A failed/incomplete read is pending, never green. Rate limits defer work; they do not create an LLM retry loop.

Required status-check contexts come from the **PR base branch's effective rules** plus classic branch protection, including required app identity. The latest run per name/app wins, so a queued rerun supersedes its earlier green result. All required contexts must finish before a normal pass/fail wake:

- Pass: `success`, `neutral`, `skipped`.
- Fail: `failure`, `cancelled`, `timed_out`, `action_required`, `startup_failure` (commit statuses `failure`/`error` also fail).
- Unknown conclusions and nonterminal runs remain pending.
- An active required run's suite is ambiguous: it may contain optional work or a required rerun that has not created its replacement check yet. Prompt required-only completion needs positive current-generation evidence. The plugin discovers an exactly associated Actions workflow, validates its attempt, reads every page of attempt jobs, binds terminal required jobs by exact check-run reference/name/app/suite, rereads the suite, then rereads the workflow. Matching observations and required job conclusions allow optional work in that same attempt to continue without delaying the wake.
- This is a bounded consistency check, **not a cross-resource transaction or complete list of uncreated rerun targets**. Ambiguous/newer/partial attempts, unavailable Actions access, contradictory or incomplete reads, and providers without equivalent evidence defer to later normal polls, potentially until full workflow/suite settlement. Repeated reads, 304s, timestamps, numeric ordering and debounce do not prove a missing required replacement was excluded. Legacy statuses have no suite/generation binding and wait for observed suites to settle. Universal prompt required-only latency is not promised. Expiry remains expiry, never a fabricated pass/fail.
- Queued/in-progress suites with an explicit `latest_check_runs_count: 0` and no observed run referencing that suite/app are treated as absent: installed Apps can leave these queued indefinitely without posting checks. Unknown counts/statuses and suites referenced by observed runs remain conservative, and completed suites are retained even with zero runs. This exclusion also applies to required-check ambiguity and missing-check grace; it never satisfies a missing required check.
- Without required contexts, all remaining suites and latest runs/commit statuses must be terminal. An empty head (including only empty incomplete suites) remains pending; no Actions extension is applied.
- A missing required context yields a fail wake naming `required check missing` only after twice the repository CI median has elapsed since the last suite completion (registration time if no suite exists), and no present required context remains pending.

The cold-start median is an operator-supplied measured `repoMedianMs` entry, or **30 minutes** when unknown. A rolling sample of up to 31 distinct settled registered heads replaces it. The plugin measures suite creation-to-final-completion, not agent registration-to-wake latency. A head is sampled only when every suite readiness considered has both a creation and a completion time; a missing timestamp skips the sample rather than recording a partial span. Empty incomplete suites excluded from readiness are excluded from the sample too, so if one later gains checks, that head's sample covers only the work the wake waited for. It never treats an HTTP denial as an absence of required checks. A moved head, closed or merged PR retires the wait without waking the wait's own card. A genuine new head on an open PR may additionally wake pending reviewers under "Reviewer wakes on settled PR head change" below. Fresh PR and card/workspace/config reads precede every wake; a concurrent GitHub change after the final read cannot be made atomic with the Paperclip wake.

The wake reason names pass/fail, repository, short head SHA, failed contexts and missing contexts. The host remains authoritative for assignee, blockers, terminal status, paused agents and budget. A host-deferred (`queued: false`) wait remains open. Exactly matched, known pre-queue accounting/not-sent refusals also remain open; unknown exceptions never authorize retry. A failed pre-dispatch intent write is restored to open when possible, because no wake call has occurred. Dry run logs **`would wake`**, records a terminal dry-run outcome and calls no wake API; switching to live does not replay dry-run completions.

### At-most-once boundary

Each `(repo, headSha, waitId)` has a durable intent before `ctx.issues.requestWakeup`, plus a stable correlation/idempotency key. The reported target host does **not** deduplicate that key: the plugin ledger, not host deduplication, prevents repeat dispatch. All entrypoints share a single-worker lock, including overlapping scheduled callbacks. If the host reply is lost, the wait becomes `unconfirmed` and is **not retried**; restart treats an unfinished intent the same way. This favors no duplicate requests over guaranteed delivery during an ambiguous failure. The backstop recovers missed work. Do not claim exactly-once delivery or run multiple independent plugin workers against the same ledger: stock state has no cross-worker compare-and-swap.

### Reviewer wakes on settled PR head change

When a genuine new head appears on an open, same-repository PR, the plugin records a bounded pending entry (`oldSha`/`newSha`) — either when a poll observes the moved head, or when `ci_wait_register` for the new head finds the most recent prior wait for that card/PR was on a different head (the normal push-then-register flow, where no open wait lives long enough to be polled). On later ticks the entry is re-read from GitHub, re-read again after the readiness snapshot before any wake intent (a push during the snapshot retargets the entry instead of waking for the stale SHA), and only when the **new** head has settled (`pass` or `fail` per the readiness rules above; a `pending` head never wakes) does the plugin wake each candidate card that meets **all** of:

- the card lists the PR as a `pull_request` work product (exact URL or repo+number metadata, mirroring custody's work-product tier),
- the card is `in_review` with a `pending` execution stage that has a current participant, and
- the current participant is not the pusher/author (see below).

Candidates are discovered from the ledger's own registered waits for that (company, repo, PR): the plugin has no company-enumeration surface and does not query a work-products table, so a card that never registered a wait for the PR is not discovered. The wake uses reason `pr_head_changed` with old/new SHA in the text, `contextSource: "plugin.ci-wake"`, and a stable per-(card, SHA) idempotency key. It is wakeup-only: no status, assignment, monitor or verdict writes.

**Pusher identity design point.** GitHub PR author/pusher identities are logins, never Paperclip agent IDs, so they cannot be mapped to a participant. The plugin therefore excludes a participant only on definite agent-ID equality with a known author agent: the registering agent of any wait for that PR, or the card's `returnAssignee`. The card's `assigneeAgentId` is deliberately **not** an author source: on a real `in_review` card Paperclip reassigns the card to the pending participant, so the assignee IS the reviewer in essentially every production shape — excluding on it would exclude every reviewer (production-shape regression test in `tests/ci-runtime.test.ts`). A human participant or otherwise ambiguous identity is **woken**: a spare wake is cheap, an 11-hour review stall is not. Failure mode: a teammate agent pushes a new head while the registering agent differs, producing one spare wake — never a missed wake.

Idempotency is per (card, SHA): the plugin persists a dedupe record before `requestWakeup`, so a lost reply or restart never repeats that (card, SHA) effect; known pre-queue refusals release the record for a later tick, unknown errors stay unconfirmed. Entries expire after seven days and dedupe records after 30 days, under the same tick budgets as CI waits (the per-tick wake budget is checked inside the candidate loop too: dispatch stops at the cap, the entry is kept, and the remaining candidates resume next tick). The pending-entry and dedupe maps also carry explicit count caps (1,000 and 10,000, evicting oldest first, like `deliveries`); dedupe records a still-pending entry relies on are never evicted by the cap, so a woken candidate cannot repeat while its entry is still outstanding. Shadow logging is per candidate card — a card that becomes eligible later for the same head change is still logged once. This path ships **disabled** (`prHeadWakeEnabled`, default `false`) and in **shadow** (`prHeadWakeShadow`, default `true`): shadow logs `would wake` once per candidate and fires nothing; switching to live wakes on the next tick. `dryRun` is a global kill-switch that is honored here exactly like `prHeadWakeShadow` — effective shadow is `prHeadWakeShadow || dryRun`, and `dryRun` is included in the before-wake revalidation — so an operator rollback via `dryRun: true` (or `enabled: false`) silences this path too. A closed/merged/forked/renumbered PR, a revoked allowlist entry, or a disabled feature drops the pending entry without waking.

## Configuration and limits

The CI registration/polling path uses these capabilities:

```text
webhooks.receive  jobs.schedule  issues.read  issues.wakeup  issues.checkout
execution.workspaces.read  agent.tools.register  plugin.state.read
plugin.state.write  http.outbound  secrets.read-ref
```

No issue creation/update/comments, company/project enumeration, SQL namespace, shell or GitHub resource writes on the CI registration path. App mode adds only the fixed installation-token exchange below. CI registration discovers companies only from its own registered waits. Custody adds the explicitly listed read/create/document capabilities below. The gates publisher adds `events.subscribe` and `issue.interactions.read` and performs exactly one GitHub write: a fixed-context `paperclip/gates` commit status per SHA (see "Gates status publisher"). It has no issue-update/comment, shell or company-enumeration surface. Secret references resolve **at call time**; key material, JWTs and tokens are never returned/logged/stored in plugin state. Do not paste credential values into config; use Paperclip secret pickers.

| Config | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Master switch; rejects registrations and stops rechecks when disabled. |
| `dryRun` | `true` | Log/record would-wake decisions without waking. |
| `allowedRepos` | `[]` | Explicit owner/repo allowlist; mandatory when enabled, maximum 200. |
| `githubTokenSecretRef` | unset | Bearer mode: existing read-only token reference. Do not configure any App field with this. |
| `githubAppId` | unset | App mode: numeric App ID, as a positive decimal string. |
| `githubInstallationId` | unset | App mode: existing authorized installation ID, as a positive decimal string. |
| `githubAppPrivateKeySecretRef` | unset | App mode: existing approved RSA private-key reference; requires both IDs and excludes bearer mode. |
| `repoMedianMs` | `{}` | Measured cold-start repo medians in ms, 60,000–86,400,000. |
| `gatesStatusEnabled` | `false` | Publish `paperclip/gates` commit statuses from RM merge confirmations. Ships off; without the App `statuses: write` grant the publisher fails closed as `missing_permission` and never greens a SHA. |
| `gatesStatusShadow` | `true` | Shadow mode: compute and log decisions without POSTing any GitHub status. Set `false` only after shadow evidence matches RM decisions. |
| `releaseManagerAgentId` | unset | The one agent whose accepted merge confirmations publish `paperclip/gates`. Required when `gatesStatusEnabled` is true. |
| `prHeadWakeEnabled` | `false` | Wake pending reviewers (`in_review`, pending stage) when their PR head changes and settles. Ships disabled; wakeup-only, never status/assignment writes. Requires `enabled` and the same allowlist/auth as CI waits. |
| `prHeadWakeShadow` | `true` | Shadow mode: compute and log intended `pr_head_changed` wakes without firing any. Set `false` only after shadow evidence is accepted. |
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
| `metadata: read` | Effective branch rules; requested explicitly on every mint |

The gates publisher mints a separate token through the same exchange requesting exactly one permission, `statuses: write` ([`GATES_PERMISSIONS`](src/ci-auth.ts)), never combined with the read envelope. Until the App is granted `statuses: write`, mint validation or the write POST fails closed as `missing_permission` (logged, 60-second per-SHA cooldown, entry retained for retry; never a green status).

The [GitHub permission reference](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps) and [installation-token API](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app) define these scopes. These are requested permissions, **not evidence the App has them**. Public repositories do not prove protection/Actions access. An installation not covering the repository, missing grants, expired/revoked credentials or an unexpected envelope blocks the read. There is no bearer, anonymous, broader-permission or all-repository fallback. The response must identify exactly the requested owner/repository, exactly the six requested read permissions, and expiry 60s–61min ahead. Denied exchanges never become readiness evidence.

Only the installation token is reused, in private memory for one bounded auth cycle (each source lives at most 180s; a 600s tick that outlives a source mints a fresh one rather than reusing an expired credential); concurrent requests share one exchange. Registration and signed-hint rechecks use the same auth code with fresh cycles. Tokens renew if within 60s of expiry; a failed renewal or 401 ends their use in that cycle. App IDs, installation and key references remain operator configuration, never agent arguments. Each exchange consumes the same request/deadline/backoff budgets as reads; installation backoff spans repositories, companies sharing that installation and private-key reference rotation. Backoff is kept separately from company-isolated response caches, so their eviction cannot discard a live throttle; at capacity, new credential identities are refused rather than evicting throttles. Token responses are never ETag-cached. The exchange response acceptance cap is 16 KiB, **not a host streaming cap**.

GitHub-issued tokens expire upstream after about one hour; this plugin discards them after the cycle but does **not** revoke them or shorten GitHub's TTL. Crashes/ambiguous mint replies can therefore leave an unused token valid until expiry. Local references/garbage collection are not cryptographic memory erasure. A compromised worker with the App private key can exceed these requested scopes: token down-scoping does not narrow key authority. A supported scoped-token broker could keep that key outside the worker, but its authorization, isolation, endpoint coverage and availability must be established rather than assumed. The public stock SDK does not provide plugin-to-plugin tool invocation; this App mode directly resolves the approved key only at call time and adds no internal service dependency. Security must explicitly disposition that route, the actual key ceiling, host buffering/cancellation/trace behavior and token-lifecycle residuals before installation. Creating/rotating credentials, changing App permissions/repositories, placing secrets or installing/enabling the plugin remain separately authorized actions.

Bearer mode uses an existing approved read-only token. Prompt same-attempt reconciliation needs **Actions: read**; without it, active-suite evidence defers conservatively until settlement. App mode intentionally requests the fixed complete read envelope above and never retries with fewer or broader scopes. Verify the actual plugin credential rather than an agent's separate GitHub identity.

Hard runtime caps: 300 simultaneous open waits across the installation; 8,000 retained waits; seven-day active TTL; 30-day dedupe tombstones; 5,000 recent safe audit entries; 3,600 HTTP requests / 600 seconds / 100 wake attempts per tick. Sizing rationale: at the measured load of 103 open cards polling for CI, 300 open waits with a 15-minute backstop poll covers the real waiting population (a single sweep costs roughly 7–10 conditional requests per wait, inside the 3,600 request budget); webhook hints, not polling, provide prompt wakes, so the backstop only bounds worst-case latency. Bounded per-client page and response limits may defer large heads rather than truncate results. Expiry/compaction run on the independent scheduled job, including while disabled. No cloud resources are provisioned and no paid runner is used, so provisioning/spend reservation and cloud teardown are not applicable. Routine poll intents are evicted before wake/refusal evidence, preserving the current call's audit-before-credential write. Other events can still exhaust the ring; the Operator must export required evidence before eviction.

## Gates status publisher (separate opt-in, owner order B)

`gates-status-sweep` runs every four minutes; `issue.updated` also enqueues and drains one card immediately. The publisher reads the issue thread's interactions and publishes the commit status `paperclip/gates` only for the dedicated RM merge-authorization contract: kind `request_confirmation`, addressed to and resolved by the configured `releaseManagerAgentId`, title `Merge <owner/repo>#<n>?` with the prompt identical to the title (the question RM was asked is the merge itself), details the bare PR URL for the same repo/number, no summary or acceptance label, no target or enrichment block, exactly one `owner/repo#N` across the contract fields, and exactly one distinct 40-hex head SHA — the SHA the RM cites in the resolution reason. A generic confirmation that merely mentions "merge" (for example a hold card the RM accepts) is never merge authorization. Outcome mapping: `accepted` → `success`; `rejected`/`expired`/`cancelled`/`failed` → `failure`; result outcome starting with `superseded_` → `pending`. Everything else — missing or ambiguous SHA/PR, wrong resolver, mis-addressed or non-contract cards, pending cards — publishes nothing. Only allowlisted repositories are written; exact-match repo validation happens before any POST.

GitHub commit statuses are per-SHA, so a new push has **no** green status until a new RM confirmation cites that SHA. The publisher never synthesizes a status for an uncited head. When a thread retains several RM decisions for one repo+SHA, only the authoritative (newest, by host decision time) one is published, and a persisted per-SHA watermark prevents any older retained decision from republishing on any replay or list order. Statuses are otherwise deduped per `repo+SHA+state` (a newer decision with a changed state re-publishes) and capped below GitHub's 1,000-statuses-per-SHA limit. Shadow decisions are retained per SHA, so flipping `gatesStatusShadow` off publishes them on the next event/sweep; missing-permission retries never exhaust and publish once the grant arrives. Rollout is evidence-first: `gatesStatusEnabled: true` with `gatesStatusShadow: true` (the defaults, except enabled) compares logged decisions against RM decisions on live PRs before the owner adds `paperclip/gates` as a required status and the Operator flips shadow off. UNDO is owner-owned: remove the required status and set `gatesStatusEnabled: false`. The ruleset change and the App `statuses: write` grant are **not** done by this plugin or its PR.

## Retained build package (not installation or publication)

After `check` passes on a PR head or a `main` push, the same job packs and validates the built package, then uploads an immutable Actions artifact named `ci-wake-<source SHA>-<run ID>-<attempt>`. Checkout targets the exact PR head rather than the synthetic merge. Only the existing `contents: read` permission is needed; there is no registry publication, release, installation or deployment step.

The artifact contains the installable `.tgz`, `package-files.json` (every packed file's size/SHA-256), `validation.json`, `provenance.json` and `SHA256SUMS`. Validation inspects the **actual tar archive**, rejects extra files/links, compares packed bytes with the successful build workspace, checks the manifest/worker/version and entrypoints, imports the packed public API against the locked SDK and syntax-checks the worker without starting it. The package still requires the host's compatible SDK peer; it does not bundle dependencies or establish host governance/operational acceptance. The native npm controls disable lifecycle scripts and apply a three-day release-age filter; a frozen existing lock is not a retrospective release-age audit. No script exceptions are granted.

Provenance records the source SHA, executing workflow ref/SHA (which can differ from the checked-out PR head), run/attempt/job identity, Node/npm, installed and locked dependency versions/integrities, lockfile hash and tarball hash. Upload's immutable artifact ID, URL and archive digest appear in the job summary; they cannot be embedded inside their own archive. After the job finishes, retain the run/job URLs and successful conclusions plus the artifact API receipt (`id`, `digest`, `created_at`, `expires_at`, `expired`, `workflow_run.head_sha`). Compare that receipt with the summary and downloaded bytes. This is checksummed build provenance, **not a signed attestation** or authorization to install.

Download by artifact ID into a new empty directory (`gh api repos/TogetherWeOwn/paperclip-plugin-pr-doer-wake/actions/artifacts/<id>/zip > artifact.zip`). Verify the archive's SHA-256 against the API `digest` before extraction; then run `sha256sum -c SHA256SUMS` inside the extracted bundle. Inspect `package-files.json` and `validation.json`, and retain the exact-source receipt with the bundle. Never run package scripts just to inspect a download.

Retention is **30 days requested**, capped by repository/organization policy: the API's actual `expires_at` is authoritative. Artifacts are not indefinitely available and can be deleted sooner by an authorized administrator. The qualification integrator must download and preserve the reviewed **merged-source** bundle and receipt in its approved evidence store before expiry, record the destination and checksum, and hand that exact tarball to the separately authorized installer. If no approved preservation route exists, route that prerequisite rather than claiming preservation. A PR bundle is review evidence only: after squash merge use the successful `main` build at the squash SHA, record the source delta from `02b3298cdc320c8d663a729301328a007ba0522e`, and obtain artifact/config/host acceptance independently of any earlier source-only review.

No staging or preview runtime is provisioned by this pipeline; no recurring always-on staging cost, startup, keep-alive or cleanup resource is introduced. Future staging/preview must run on demand or scale to zero when idle, with trusted SHA/environment-bound startup/readiness, a bounded use window and native cleanup/expiry even after failure/cancellation. Always-on cost requires a dated owner exception; production is unchanged.

## Operator installation and live operation (phase one)

1. Verify the exact final head through GitHub Actions and permitted bounded local checks. Retain Actions run/job links, required CodeQL and completed Devin analysis, finding dispositions and native Security → QA. Complete `ACCEPTANCE.md`, including exact-artifact/host/configuration Security sign-off and native-tool governance coverage on the target stock host. A manifest declaration is not evidence that governance ran.
2. Obtain applicable Release Manager production authorization before installation/activation. An Operator installs/upgrades the reviewed package, preserving the plugin ID. Configure an **existing approved** credential reference with the secret picker. For App mode, the existing approved installation must cover the target repository and the exact six read permissions above. Do not create/rotate keys, add repositories or increase App grants as part of installation; those require separate owner authorization and authorized administrative work. Source merge grants none of it.
3. Replace old configuration, do not carry its heuristic fields forward. Install enabled with `enabled: true`, `dryRun: false`, allowlisting the repos in the scaled allowlist below (digest `3202dad14d8014c74e39d39d55a5c68d5840fdd555f40fdfdb0dedcaf94958f2`). Keep `webhooksEnabled: false` for the first live window (backstop polling only); there is no canary trial, twenty-head acceptance gate or disabled-first rollout. `dryRun` remains available as a configuration/rollback switch, not a required rollout stage.
4. Record evidence of authorized live operation, including registration, authoritative GitHub/check timestamps and actual host queue/run receipts. Count ambiguity, caps, HTTP denials and failed reads explicitly; they are not passes. Dry-run records stay terminal and never replay automatically in live mode.
5. Route the registration/backstop instruction change through its normal reviewer/applier, retaining the accepted operational envelope: register after push and keep a long backstop `max(15 minutes, 2 × repo median)`. Do not change instructions or remove backstops merely because code merged.

Old SQL migrations remain as historical schema definitions, not active manifest migrations. Existing database evidence is neither read nor deleted. The previous `github` endpoint and check_run/pull_request subscriptions are retired; no old webhook settings are reused automatically. The Operator/owner must handle obsolete settings separately under their normal authority.

## Exact owner steps for optional webhook hints (phase two)

After phase-one acceptance, the owner who administers GitHub and holds the new secret:

1. Generate a high-entropy webhook secret privately. Do not send it to an agent, an issue, the Operator or this repository.
2. Store it directly in a Paperclip company secret. Bind its reference as `webhookSecretRef` for the reviewed plugin, using the secret picker; never a raw string.
3. In the authorized target GitHub repository **Settings → Webhooks → Add webhook** (later the organization **Settings → Webhooks → Add webhook**), set payload URL to `https://<your-public-paperclip-host>/api/plugins/<installed-plugin-id>/webhooks/github-ci`. Use the installed record's route identifier, not an assumed UUID. Content type **application/json**; **SSL verification enabled**; enter the same secret privately.
4. Select **Let me select individual events → Check suites, Check runs, Workflow runs and Pull requests**, then **Active**. Do not select all events. The plugin accepts only `completed` check_suite/check_run/workflow_run events and `opened`/`reopened`/`synchronize`/`ready_for_review` pull_request events. Unsupported events are ignored without parsing; supported events over 64 KiB are rejected before parsing; within-cap non-terminal actions are ignored. Commit statuses have no webhook and are still caught by the backstop poll.
5. Operator enables `webhooksEnabled` only after the owner confirms the webhook/secret placement. Validate one real completed check-suite delivery and its HMAC verdict, then prove the resulting read sees current GitHub state. A delivery itself is not CI completion evidence.
6. Monitor the host's webhook-delivery table/storage growth during authorized operation: stock host may persist raw bodies/headers before plugin verification and may not prune them. If that risk is not accepted, leave webhooks off and use polling. Protect public ingress with existing limits if authorized; this plugin cannot enforce pre-storage retention.

The plugin verifies SHA-256 HMAC over the **raw body** with `timingSafeEqual`, ignores `parsedBody`, requires delivery UUIDs, retains a 24-hour replay guard and checks repo/org against the allowlist. The event is only a hint for the same readiness recheck. Supported-event payloads are capped at 64 KiB, enforced before any JSON parsing; before any ledger/config RPC, admission is limited to 32 outstanding hints and 240 candidate bodies per minute. Verification is independently capped at 120 secret resolutions per minute per worker (the binding budget at scale); hints are debounced 10 seconds per head and capped at 120 per minute. Oversized/busy hints may be dropped safely: the 15-minute backstop poll remains authoritative.

## Scaled allowlist (push mode at scale)

Measured 2026-11-10 via `gh repo list TogetherWeOwn --limit 200 --json name,pushedAt,isArchived`: **49 non-archived repositories pushed within the last 14 days** (53 including archived; an earlier 61-repo figure predates this measurement and was not reproduced). The Operator pastes these exact lowercased `owner/repo` strings into `allowedRepos`; the canonical digest is the SHA-256 of the compact JSON array printed by the command below (lowercased `owner/repo` strings in that command's sort order): `3202dad14d8014c74e39d39d55a5c68d5840fdd555f40fdfdb0dedcaf94958f2`.

Reproduction:

```sh
gh repo list TogetherWeOwn --limit 200 --json name,pushedAt,isArchived \
  | python3 -c "import json,sys,hashlib;from datetime import datetime,timezone,timedelta; d=json.load(sys.stdin); c=datetime(2026,11,10,tzinfo=timezone.utc)-timedelta(days=14); a=sorted('TogetherWeOwn/'+r['name'].lower() for r in d if not r.get('isArchived') and datetime.fromisoformat(r['pushedAt'].replace('Z','+00:00'))>=c); print(len(a)); print(hashlib.sha256(json.dumps(a,separators=(',',':')).encode()).hexdigest())"
```

- `togetherweown/.github`
- `togetherweown/agent-avatar-generator`
- `togetherweown/agent-toolkit`
- `togetherweown/ai-engineer-knowledge`
- `togetherweown/boat-offload-canary`
- `togetherweown/cli-proxy-api-management-center`
- `togetherweown/cliproxy-provider-cloudflare-workers-ai`
- `togetherweown/cliproxy-provider-hopper`
- `togetherweown/cliproxy-provider-kit`
- `togetherweown/cliproxy-provider-meta`
- `togetherweown/cliproxy-provider-nvidia-nim`
- `togetherweown/cliproxy-provider-opencode-go`
- `togetherweown/cliproxy-provider-openrouter`
- `togetherweown/cliproxy-provider-synthetic`
- `togetherweown/cliproxy-provider-zai-coding-plan`
- `togetherweown/cliproxyapi`
- `togetherweown/coderabbit`
- `togetherweown/hindsight`
- `togetherweown/kagi-shinobi`
- `togetherweown/kagi-shinobi-public`
- `togetherweown/kofra`
- `togetherweown/kofra-cloud`
- `togetherweown/labelloop`
- `togetherweown/musicbrainz-cloudflare`
- `togetherweown/nntunev2`
- `togetherweown/open-personal-agent`
- `togetherweown/open-serverless-vault`
- `togetherweown/osv-kdf-candidate`
- `togetherweown/paperclip`
- `togetherweown/paperclip-operator-toolkit`
- `togetherweown/paperclip-ops`
- `togetherweown/paperclip-plugin-cf-test-env`
- `togetherweown/paperclip-plugin-cliproxy-connector`
- `togetherweown/paperclip-plugin-decision-notifier`
- `togetherweown/paperclip-plugin-decision-router`
- `togetherweown/paperclip-plugin-feed-watch`
- `togetherweown/paperclip-plugin-github-upstream`
- `togetherweown/paperclip-plugin-model-capacity`
- `togetherweown/paperclip-plugin-pr-doer-wake`
- `togetherweown/paperclip-plugin-pr-tracker`
- `togetherweown/paperclip-plugin-sandbox-boat`
- `togetherweown/paperclip-plugin-vuln-sentinel`
- `togetherweown/paperclip-r2-backups`
- `togetherweown/qerith`
- `togetherweown/routeware-shadow-api`
- `togetherweown/two-bot-next`
- `togetherweown/two-design-kit`
- `togetherweown/two-web-next`
- `togetherweown/velmora`

This delta (allowlist + caps + four webhook events) requires fresh Security delta and Release Manager acceptance through the release gate before the Operator applies it; source merge alone does not authorize installation or configuration changes.

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
| `githubTokenSecretRef` | unset | Existing approved read credential; resolved only for the tick. Exactly one of bearer or App mode. |
| `githubAppId`, `githubInstallationId`, `githubAppPrivateKeySecretRef` | unset | App mode: dedicated read-only App triple; all three required, mutually exclusive with the bearer ref. |

Custody accepts exactly one authentication mode. App mode mints short-lived installation tokens without a repository selection from the dedicated read-only App (pull_requests/checks/statuses/actions/administration/metadata = read, installed on every org repository), and every mint is refused unless GitHub returns exactly those read permissions; listed repositories must belong to the configured org. Fine-grained PATs expose no Checks permission, so bearer mode cannot read check-suite evidence; App mode is the supported checks-capable route.

The new manifest capabilities are `issues.create`, `issue.documents.read`, `issue.documents.write`, `issue.relations.read`, `projects.read`, `project.workspaces.read`, `database.namespace.read` and `database.namespace.migrate`. The last capability is required by the stock schema for **any** database declaration, including read-only access. `custody-migrations` contains no SQL; historical migrations are not activated. Only `issues`, `issue_comments` and `issue_documents` are core-read tables. Document bodies use the supported SDK, not an undeclared join. No `issues.update`, comment creation, core SQL write or work-product mutation is granted.

### Mapping and triggers

Use the first nonempty mapping tier: explicit ci-wake registration; exact `work/<uuid>` head with a company card and project-repo match; an exact PR URL token in card title/description, agent comments or documents; then tracker-identifier branch plus project-repo match. Branch tiers require a same-repository head, never a fork prefix. Multiple candidates at the winning tier, or no candidates, are UNMAPPED; never select a primary owner. All card states and unrelated plugin/routine origins participate. The job excludes its own generated custody cards/documents so its output cannot become ownership or disposition evidence. Work-product mapping is not implemented because the pinned SDK has no read API; the existing upstream [work-product read proposal](https://github.com/paperclipai/paperclip/issues/17887) tracks this gap. Any SDK contribution is a separately gated follow-up, not an invented table grant or a duplicate issue.

Triggers:

- Open PR idle for seven days since the latest push/head observation, commit, submitted review, head check-suite update, or PR-specific `PR disposition:` line. A newly observed head is seeded from head-bound evidence only (head suite `updated_at`, submitted review on the head commit, floored at `created_at`) instead of wall-clock arrival, so an already-idle PR triggers on discovery; PR-wide evidence such as older-commit reviews or the disposition line cannot date a head SHA. A head with no head-bound evidence stays UNKNOWN (no idle wake) until head-bound evidence arrives; later evidence seeds the retained head. Only a changed SHA gets an intentional arrival-time warmup. A latest `defer` with a future UTC revisit date suppresses idle. Holds must be recorded as such a defer; unrelated PR directives do not count. `finish` lines become stale again after seven days.
- Open PR on a `done`, `cancelled` or `backlog` card. Stable card/status-version identity defines the epoch, not document writes or generic `updatedAt` churn.
- Closed unmerged PR missing a `Closed unmerged:` line on **either** the mapped card or the PR. The card line must contain exactly one explicit semicolon-delimited source field, e.g. `Closed unmerged: superseded by example/project#99; source example/project#42; unique work: kept`. The source is a repository/number or exact GitHub PR URL; successor mentions and missing/ambiguous sources do not count. A valid superseded closure is not reopened.

GitHub's GraphQL `Commit.pushedDate` is deprecated and may be null. Commit author/committer dates do **not** prove push time, and PR metadata `updatedAt` is not used as a substitute. The job persists first observation of each head and resets it to arrival time on SHA changes. First observations are seeded from head-bound evidence (see above), so an already-idle PR triggers on discovery; a first observation with no evidence stays UNKNOWN until evidence arrives; a changed SHA always gets a conservative seven-day warmup. Later review/check/disposition activity extends the epoch. Unknown/missing activity still blocks idle, but cannot erase an independently proven terminal-card trigger. This warmup is a documented coverage/latency limit, not a claim of historical push evidence.

### Effects, state and recovery

Keys are `repo#number|kind|epoch`; the same key is the wake idempotency key and any created child's `originId`. For an assigned, unblocked `todo`/`in_progress`/`in_review` card, append bounded PR/head/trigger evidence to its `pr-custody` document and explicitly request a native wake. Otherwise create a `todo` child assigned to the source's agent (configured summary recipient when absent), save evidence, then explicitly request the wake. Creation alone does not wake. Current config, card assignment/status/blockers and PR head/state are rechecked before dispatch; the host remains authoritative for its native run/budget gates. No task status, review policy, PR, branch or work product is modified.

At most **15 trigger effects per tick**, including uncertain creation attempts. Scheduling is least-recently-preflight-admitted first across repos and the daily summary, then oldest trigger first. PR turns advance durably only after the GitHub client admits the first revalidation request: budget/backoff refusals retain priority, while admitted failures before any native effect still yield. Cached transport retries consume requests but not extra turns. The client owns the sole request counter; discovery reserve refusals occur before it advances. Daily summaries use native preflight admission. Persisted turns rotate positively deferred retries behind waiting work without replaying uncertain effects. Unmapped and bot PRs go into one daily summary card, not one card per PR. Its document accumulates observed items for the day; its wake is requested once. No comments are posted. A fresh PR-specific disposition acknowledges a previously observed terminal trigger; closure rationale is still required on both sides. Stable source/line fingerprints retain disposition timestamps across unrelated card or document edits. An unchanged line is not a fresh acknowledgement; posting it in a new comment, or changing the directive, is a new record. Cached child assignment/status/blockers are revalidated before wake; stale children fail UNKNOWN instead of waking a previous owner.

Durable creation/wake intent precedes each effect. Restart/ambiguous wake replies are `unconfirmed` and never replayed automatically; a possibly created card can only be recovered by its exact origin. `queued: false` and narrowly recognized stock-host pre-enqueue refusals are positive no-dispatch evidence and may retry. An intent-write failure or deadline guard known to precede RPC invocation restores pending state; a genuinely ambiguous invocation still never retries. Preserve existing backstops and inspect unconfirmed records manually. One worker only: plugin state has no distributed CAS. Live and dry-run state are separate so promotion cannot consume live dedupe keys or skip the initial live closure inventory. Closed cursors retain inclusive second-precision overlap and do not advance past undispatched/deferred/unconfirmed closures or summaries containing closures from that repository. Open-only trigger/summary uncertainty remains UNKNOWN without pinning unrelated closure coverage. Inventory reserves 100 HTTP attempts and 30 seconds for dispatch so discovery budget exhaustion cannot consume all delivery capacity. Repositories refused before inventory starts retain their earlier attempt time so subsequent ticks rotate toward skipped repositories. Within each repository, a durable PR-number continuation rotates expensive activity/closure reads after the last admitted PR, regardless of REST ordering. Budget-skipped reads remain UNKNOWN and existing exact-head clocks are not reset. The continuation and effect-admission fields are additive to existing ledgers.

State namespace `pr-custody-v1`, company scope, key `<org>:dry` or `<org>:live` stores cursor/receipt/head observations, a latest inventory report, and 1,000 safe audit records retained at most 30 days. Reports project only PR identifiers, card IDs, mapping source, trigger keys and UNKNOWN scopes, never raw API/card bodies or credentials. The hot receipt and disposition-clock maps each cap at 20,000. Near capacity, each tick moves at most 128 settled (`woken`/`cleared`) receipts and 128 clocks into separate exact-key archive entries in the same namespace/scope/mode: `<org>:<mode>:receipt:<sha256(trigger)>` or `<org>:<mode>:disposition:<sha256(fingerprint)>`. Archive writes must succeed before hot eviction; hot misses must read/validate the archive before a new effect or clock is allowed. Read/write failure is UNKNOWN, never absence. Archives do not expire: lifetime history uses durable storage rather than exhausting the hot maps or erasing dedupe. Storage therefore grows with distinct settled triggers/directives, with bounded writes per tick; target-host capacity/durability must be accepted. Pending/attempting/unconfirmed receipts stay hot and are never automatically removed; if unresolved work alone fills the cap, new effects fail closed pending manual reconciliation. Preserve both hot ledger and archives on backup/restore/rollback; never delete either to retry a wake. Head observations cap at 10,000; complete repository/open snapshots retire observations no longer monitored/open, preserving clocks of still-open PRs. Reopened/re-visible PRs are re-observed as first observations and seeded from head-bound evidence, so an already-idle reopened PR can trigger on discovery. Per tick: 1,200 attempted HTTP requests, 20,000 host-read admissions and four minutes. Card snapshot caps are 20,000 cards, 100,000 comments, 10,000 documents and 64 MiB text; per-body limits and HTTP page/byte/cache/time limits also apply. These are refusal budgets, never silent truncation. No cloud resources or spend reservations exist, so TTL/auto-teardown of provider resources is not applicable.

### Custody rollout gate

1. Native Security sign-off on exact source/artifact, expanded capabilities, core-read/privacy boundary, GitHub grant, single-worker state and host transport; then QA using exact-head Actions evidence.
2. Operator installs the reviewed package with custody disabled, binds the existing approved credential, chooses the one company/org/summary recipient and initial closure boundary, then enables **dry run first**. Creating/rotating/widening a credential is a separate authority decision.
3. Compare the saved inventory against a manual REST inventory of every non-archived repo and every open PR, plus the chosen closed boundary. Require zero omitted repos/PRs, no false owner/primary-owner choice, correct mapped/unmapped/bot classifications, zero duplicate effects, no premature idle wake, and correct closed-between-ticks/rationale handling. UNKNOWN evidence and head warmup are explicit incomplete qualification, not passes.
4. Reconcile the existing detector so it cannot duplicate disposition asks; retain only its work-product-label repair responsibility. Operator enables live only in the accepted envelope and records actual native wake receipts.
5. Only after live adoption, queue the Detection-rule replacement through its existing instruction reviewer and configuration window. Source merge is not installation, live acceptance, or permission to replace operational rules.

Rollback: Operator disables `custodyEnabled` (or sets `custodyDryRun: true`) and preserves state/backstops. Do not delete tombstones to retry an ambiguous effect, reinstall old guessing behavior, or automatically close/reopen PRs. Existing CI configuration can remain independent.

## Development

SDK fixture targets: locked `@paperclipai/plugin-sdk@2026.1023.0` and an isolated exact `2026.1106.0` Actions compatibility job (SDK plus shared package version asserted). `tests/ci-sdk.test.ts` runs through the installed SDK's actual RPC Response wrapper, including App POST and conditional 304 recovery; it does not prove actual host transport, governance, buffering, cancellation or trace hygiene. GitHub REST API version `2022-11-28`. Tests use synthetic fixtures and no live provider calls. GitHub Actions is the CI of record: the `check` job runs locked dependency installation, typecheck, Vitest and build on a standard hosted runner. Push a draft PR and record the exact head's run/job links. Do not run a full suite or CI mirror on a shared host. Before pushing, run the existing bounded formatter/linter, project typecheck and changed/covering unit files, recording commands, scope, elapsed time, results and justified skips separately from exact-head Actions evidence.
