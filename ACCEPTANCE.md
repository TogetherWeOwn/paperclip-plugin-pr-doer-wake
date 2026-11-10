# Acceptance record: CI wake and PR custody

The CI-specific sections below preserve prior source-review evidence. They do not accept the custody expansion; its new matrix and pending gates are listed at the end.

**NOT ACCEPTED FOR INSTALLATION.** Fill exact source/artifact/host evidence through the native Security and QA review, then the Operator canary. A completed test implementation is not an observed passing test.

## Inventory and authority

- Tool: `ci_wait_register` (state-writing registration; no provider mutation), exact four-field closed schema in `src/manifest.ts` and `src/ci-config.ts`.
- Provider ceiling: existing approved GitHub read credential for allowlisted repos; optional separate owner-held webhook HMAC secret. Record actual grant/resource scope at installation, never values.
- CI path's original permission envelope: eleven capabilities. The current manifest additionally declares custody's core reads, issue creation and document writes; see the custody expansion below. No issue-update/comment creation or core SQL write is exposed.
- Source/artifact digest/config envelope: **pending native review evidence**.
- Threat model and runbook: [THREAT-MODEL.md](THREAT-MODEL.md), [README.md](README.md).
- SDK fixture target: `@paperclipai/plugin-sdk@2026.1023.0`, lockfile; REST `2022-11-28`. Installed target-host version: **pending Operator evidence**.

## Policy-to-test matrix

| Boundary | Fixture file / coverage |
| --- | --- |
| Schema / identity / authorization | `tests/ci-runtime.test.ts`: unknown keys, invalid values, checkout assertion, foreign company/project, exact execution-workspace repo/branch, spoofed head |
| No guessed mapping | `tests/ci-runtime.test.ts`: unregistered branch/body hints cannot wake; registration requires host ownership and matching current PR |
| Required readiness | `tests/ci-github.test.ts`: pending/green/fail/missing, unknown conclusions, rerun, app-bound requirements, no-required suite gates; same-attempt optional jobs, exact Actions run/attempt/job/check binding, generation changes, missing/partial targets, unavailable Actions and status deferral |
| Completeness / bounds | `tests/ci-github.test.ts`: more than 100 runs, rules/suite/status pagination, page/request/body/cache bounds, partial/denied errors |
| Conditional reads / failure | `tests/ci-github.test.ts`: ETag/304, conditional-wrapper failure and authoritative reread, rate limits, timeout, redirects |
| HMAC / replay | `tests/ci-runtime.test.ts`: raw SHA-256 signature, wrong/missing/algorithm, replay, parsed-body spoofing, repo allowlist, hint/verification budgets |
| Once-only / crash / races | `tests/ci-runtime.test.ts`: same-run retry, joining alias, new-run rerun, head-move retirement, concurrent poll/register, deferred host, lost reply/restart, intent-write failure |
| Credential hygiene | Both fixture files: distinctive synthetic credentials absent from results/errors/logs/state, reflected upstream payloads refused |
| TTL / caps / audit | `tests/ci-runtime.test.ts`: immutable wait expiry, bounded open/retained ledger, audit intents/refusals/outcomes, dry-run and no-wake behavior |
| Manifest / host schema | `tests/ci-manifest.test.ts`: exact capability set, closed tool schema, stock manifest and secret-picker schema contract |

This matrix indexes tests to be executed in Actions; it is not a claim that every arbitrary malicious input is covered. Provisioning, billable reservations, cloud teardown and destructive approvals are not applicable: no provider writes/resources are exposed. Native tool governance and immutable audit coverage are still required evidence.

## Verification evidence

- Dependency preparation: `npm ci --ignore-scripts` completed; this does **not** prove tests/builds pass.
- Full local suite / local CI mirror: **not run**, intentionally; GitHub Actions is CI of record.
- Reviewed baseline `72b5efe4b5a2ab84128255b7f57c69d8576a4979`: [Actions check job](https://github.com/TogetherWeOwn/paperclip-plugin-pr-doer-wake/actions/runs/42759532185/job/129641696961) passed typecheck, 220 tests across three files, and package build. [CodeQL](https://github.com/TogetherWeOwn/paperclip-plugin-pr-doer-wake/actions/runs/42759526548) and [PR standards](https://github.com/TogetherWeOwn/paperclip-plugin-pr-doer-wake/actions/runs/42759532176/job/129641696723) also passed at that SHA. This evidence does **not** cover later repair commits; those require fresh exact-head Actions evidence on [PR #6](https://github.com/TogetherWeOwn/paperclip-plugin-pr-doer-wake/pull/6).
- One fresh-context diff review completed with seven findings, repaired together in `72b5efe` and statically accepted by that reviewer. Subsequent automated and native review requested a delta repair: conservative missing-check grace, user-owned webhook hints, obsolete-binding retirement, disabled-poll audit preservation, and this evidence reconciliation. Regression fixtures were written before behavior fixes; no red-before execution is claimed. Existing finding threads carry the fixed/rejected/duplicate dispositions; their acceptance and fresh exact-head checks remain merge gates. No native approval or host qualification is inferred.
- Prior source-only head `5abda541d599899ccf14497a86d18c0fb37dc1a4`: [Actions](https://github.com/TogetherWeOwn/paperclip-plugin-pr-doer-wake/actions/runs/42767958601/job/129668803636) passed typecheck, 258 tests and build; [CodeQL](https://github.com/TogetherWeOwn/paperclip-plugin-pr-doer-wake/actions/runs/42767956176) and [standards](https://github.com/TogetherWeOwn/paperclip-plugin-pr-doer-wake/actions/runs/42767958954/job/129668806806) passed. Source-only Security delta acceptance was recorded; no downloadable artifact/host/install qualification was inferred. Those results do not cover the current Actions attempt/job reconciliation delta, which needs fresh exact-head Actions, Devin and applicable specialist acceptance. Current regression fixtures were written before the behavior repair; no executed red-before reproduction is claimed.
- Readiness contract: prompt required-only completion requires positive current-generation evidence. Same-attempt optional work is nonblocking when corroborated; ambiguous generations, unsupported providers and unavailable Actions reads conservatively defer, potentially until full settlement. Stable rereads are not a publication fence; expiry never fabricates CI pass/fail. Validate the actual existing plugin credential's Actions-read grant at host qualification without expanding it.
- Native Security acceptance: **pending for the current Actions endpoint/readiness delta**, must name exact source/artifact/configuration/permission envelope; prior-head source-only acceptance is not current-head approval.
- Native QA verdict: **pending**, must use exact-head Actions and applicable review gates.

## Target-host qualification (before install/live)

Record evidence, not screenshots alone, for:

1. `ctx.tools.register` calls traverse the intended native tool-governance evaluator and immutable audit path; missing governance is an explicit acceptance gap, not an inferred grant.
2. Host checkout-owner enforcement binds company/agent/run, and workspace reads enforce company access.
3. Real SDK conditional 304 behavior, redirect refusal/authorization handling, bounded network work and secret-trace hygiene. Worker timeouts do not prove host request cancellation.
4. One worker per ledger, state durability, stable host idempotency, ambiguous reply and restart handling. No unsupported cross-worker fencing claim.
5. Optional webhook ingress pre-storage retention/rate controls and owner acceptance of delivery-table growth. Phase two stays disabled until accepted and owner-created secret/webhook exist.
6. Actual read credential grant, allowlist, canary repository and measured baseline median; no expanded credential or paid runner authorized by this record.

## Canary / handoff evidence

- Operator install of the Security-accepted artifact: **pending**.
- Dry-run first 20 distinct registered heads: **pending**; require 0 premature, 0 missed beyond one poll, 0 duplicate wakes with per-head GitHub/check and poll timestamps.
- Live host queue/run receipt: **pending**, only after dry-run exit and accepted live configuration.
- Agent registration/backstop instruction adoption: **pending**, only after canary/live acceptance through the normal instruction reviewer/applier.
- Rollback/revocation proof: **pending**; runbook specifies dryRun/disable, remove bindings/tool access, owner disables optional webhook, retain card backstops.

Do not erase the ledger to replay an unconfirmed wake or reinstall the old ownership heuristic as an automatic rollback. No installation or security exception is granted by merging source.

## Custody expansion: not accepted for installation

Provider: same configured existing GitHub read credential, with organization repository listing and generated GraphQL activity queries added to the read surface. Native capability additions: issue creation, document read/write, relation/project/workspace reads, restricted core table reads, and stock-schema-required namespace migrate. The active migration directory intentionally has no SQL. Source authority remains build/test/review only, never installation, credential creation/rotation/widening, or automatic PR disposition.

| Boundary | Changed fixture / evidence |
| --- | --- |
| Full inventory / endpoint-specific pagination | `tests/custody-github.test.ts`: more than 100 repos/pulls/commits/reviews/suites/comments, inclusive closed cursor, closed-between-polls support, duplicate/count/cursor/identity/malformed/partial rejection |
| Transport / credential hygiene | `tests/custody-github.test.ts`: fixed-origin reconstructed Link pages, reflection and redirects, GET ETags versus generated GraphQL POST cache bypass, request/body/page limits; existing CI transport fixtures remain regression coverage |
| Push evidence / conservative warmup | `tests/custody-github.test.ts`: null push evidence without observation floor UNKNOWN, persisted floor maximum, invalid floor refusal, seven-day boundary, later review/suite activity; GraphQL schema marks pushedDate unsupported since 2023 |
| Tenant / core read / budgets | `tests/custody-reader.test.ts`: parameterized company/keyset reads, state/origin coverage, per-document identity, no undeclared body join, duplicate/partial/cross-company rejection, row/body/64-MiB refusal limits |
| Ownership tiers / ambiguity / injection | `tests/custody-policy.test.ts`: registration precedence, project/same-repo branch guards, URL-token boundaries, human-only ownership refusal, multiple candidates UNMAPPED, tracker fallback |
| Triggers / PR attribution | `tests/custody-policy.test.ts`: exact seven-day threshold, disposition resets and stale finish, future defer, PR-specific directives, terminal status-version stability, missing closure rationale on either side, valid supersession |
| Native effects / durable receipts | `tests/custody-runtime.test.ts`: evidence before explicit wake, todo child status, source/summary recipient, blocker routing, restart/lost replies, exact-origin reuse, positively deferred retry, no effects after intent failure/revocation/head change |
| Dry-run / caps / coverage / cursor | `tests/custody-runtime.test.ts`: no dry-run native writes, separate live keys/cursors, 15 attempts including ambiguous creates, oldest-first closure drain, daily summary accumulation, UNKNOWN card/activity reads, preserved head observation and overlap coalescing |
| Review repairs / lifetime state | `tests/custody-runtime.test.ts`: multi-tick skipped-repo fairness, open-uncertainty cursor progress with closed-uncertainty negative controls, complete-open head retirement, near-cap settled-history archival, preserved active warmup/clocks, pending/uncertain non-replay across restart, archive read/write failure refusal; `tests/custody-policy.test.ts`: unique explicit source attribution, source/successor inversion and ambiguous-source refusal |
| Retry / fairness / calendar repairs | `tests/custody-runtime.test.ts`: deadline during create/wake intent persistence, transient intent-write recovery, exact pre-enqueue refusals versus unknown errors, over-budget in-repo activity continuation across restarts, 15 permanent queue deferrals alongside runnable work and a summary; `tests/custody-policy.test.ts`: invalid calendar/time rejection, valid leap-day and UTC controls |
| Exact host manifest/config | `tests/ci-manifest.test.ts` plus `tests/custody-policy.test.ts`: expanded explicit capability set, empty migration directory contract, opt-in/defaults/required selectors/secret picker |

Current source verification: bounded project typecheck and focused changed/covering unit files are diagnostic evidence, recorded on the source task/PR. Full suite/build/required checks must run on GitHub Actions for the exact head; no local full suite or CI mirror was run. A fresh-context diff assessment, bot thread dispositions, exact-head native Security and QA remain gates, not claims established by fixture authorship.

Before live installation, record:

1. Exact reviewed source/artifact digest, stock host/SDK versions, permissions and actual credential visibility/grants. Prove the generated GraphQL query and core-read privacy rules on that host, not just static schema acceptance.
2. Independent manual expected org/repo/open-PR inventory and chosen initial closure boundary, then compare every saved custody row. Partial visibility, UNKNOWN data and conservative head warmup must be explicit; do not claim universal historical activity coverage.
3. Explicit native Security acceptance of mapping evidence, expanded read/native-write ceilings, stock-required migrate capability, single-worker state/ambiguous-effect controls and residual races; then QA and exact-head Actions. Include exact-key archive durability/capacity and backup/restore of both hot ledger and archives: bounded per-tick compaction does not bound lifetime persistent storage. No archive TTL/deletion is safe as a retry mechanism.
4. Operator-only installation and dry-run comparison; no premature, missed beyond one tick, duplicate, false ownership, bogus closure or per-unmapped-PR creation. Dry/live state isolation and 15-effect drainage must be observed. Backstops remain in force.
5. Coordinate the old detector to avoid duplicate asks, retain its label repair only, then accepted Operator live configuration and actual native queue/run evidence. Only afterwards queue the Detection text change through its configuration window. Source merge does not authorize any of these steps.
