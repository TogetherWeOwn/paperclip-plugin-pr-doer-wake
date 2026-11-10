# Acceptance record: CI wake 0.2

**NOT ACCEPTED FOR INSTALLATION.** Fill exact source/artifact/host evidence through the native Security and QA review, then the Operator canary. A completed test implementation is not an observed passing test.

## Inventory and authority

- Tool: `ci_wait_register` (state-writing registration; no provider mutation), exact four-field closed schema in `src/manifest.ts` and `src/ci-config.ts`.
- Provider ceiling: existing approved GitHub read credential for allowlisted repos; optional separate owner-held webhook HMAC secret. Record actual grant/resource scope at installation, never values.
- Permission envelope: exactly the eleven capabilities in `src/manifest.ts`; no SQL/core-table access or issue create/update/comments.
- Source/artifact digest/config envelope: **pending native review evidence**.
- Threat model and runbook: [THREAT-MODEL.md](THREAT-MODEL.md), [README.md](README.md).
- SDK fixture targets: `@paperclipai/plugin-sdk@2026.1023.0` in lockfile and exact `2026.1106.0` in isolated Actions compatibility job; REST `2022-11-28`. The target host is reported as `2026.1106.0`; exact-version fixture compatibility is not actual host proof.

## Policy-to-test matrix

| Boundary | Fixture file / coverage |
| --- | --- |
| Schema / identity / authorization | `tests/ci-runtime.test.ts`: unknown keys, invalid values, checkout assertion, foreign company/project, exact execution-workspace repo/branch, spoofed head |
| No guessed mapping | `tests/ci-runtime.test.ts`: unregistered branch/body hints cannot wake; registration requires host ownership and matching current PR |
| Required readiness | `tests/ci-github.test.ts`: pending/green/fail/missing, unknown conclusions, rerun, app-bound requirements, no-required suite gates; same-attempt optional jobs, exact Actions run/attempt/job/check binding, generation changes, missing/partial targets, unavailable Actions and status deferral |
| Completeness / bounds | `tests/ci-github.test.ts`: more than 100 runs, rules/suite/status pagination, page/request/body/cache bounds, partial/denied errors |
| Conditional reads / failure | `tests/ci-github.test.ts`: ETag/304, conditional-wrapper failure and authoritative reread, rate limits, timeout, redirects; `tests/ci-sdk.test.ts`: actual SDK RPC Response reconstruction for App POST/GET/304 and one authoritative unconditional recovery |
| App authentication | `tests/ci-auth.test.ts`: mutually exclusive closed config, RS256 JWT, expiry/renewal/cycle cap, one-repo/fixed-permission validation, denied/revoked responses, shared budgets/backoff, concurrency and credential-free serialization; `tests/ci-ledger.test.ts`: registration/poll/signed-hint use the same App auth |
| HMAC / replay | `tests/ci-runtime.test.ts`: raw SHA-256 signature, wrong/missing/algorithm, replay, parsed-body spoofing, repo allowlist, hint/verification budgets |
| Once-only / crash / races | `tests/ci-ledger.test.ts`: non-deduplicating host fixture, poll/hint/registration/restart/ambiguous reply, explicit new-run rearming limitation; `tests/ci-runtime.test.ts`: same-run retry, joining alias, new-run rerun, head-move retirement, concurrent poll/register, deferred host, lost reply/restart, intent-write failure |
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
3. Real SDK conditional 304 behavior, redirect refusal/authorization handling and secret-trace hygiene. Exact `2026.1106.0` Actions fixture proof is distinct from actual host proof. Reported host buffering is **200 MiB with no cancellation**: 16 KiB exchange/other worker acceptance caps and deadlines do not bound host allocation or cancel requests. Independent Security must accept/reject/disposition the exact residual before install; author acknowledgment is not acceptance.
4. **Host does not deduplicate wake idempotency keys.** `tests/ci-ledger.test.ts` deliberately models every host call as a new effect: repeated poll/hint/same-run registration and restart/ambiguous replies rely on the plugin's durable ledger. New-run explicit re-registration of an already-terminal head can dispatch again, and tombstones expire; no per-SHA exactly-once guarantee. State has **no CAS/fencing**: independently verified single-worker-per-ledger deployment and durable writes remain mandatory external assumptions, not solved by tokens.
5. Optional webhook ingress pre-storage retention/rate controls and owner acceptance of delivery-table growth. Phase two stays disabled until accepted and owner-created secret/webhook exist.
6. Actual read credential/App grant, installation repository coverage, allowlist and measured baseline median; no agent GitHub credentials as qualification. Independently disposition requested pull_requests/checks/statuses/actions/administration read, broader App-key ceiling, one-hour GitHub expiry, lack of explicit token revocation and crash/ambiguous-mint cleanup. No expanded credential, App repository addition or paid runner authorized by this record. These auth, SDK, ledger, single-worker and buffering points each need an authorized review disposition before install.

## Canary / handoff evidence

- Operator install of the Security-accepted artifact: **pending**.
- Dry-run first 20 distinct registered heads: **pending**; require 0 premature, 0 missed beyond one poll, 0 duplicate wakes with per-head GitHub/check and poll timestamps.
- Live host queue/run receipt: **pending**, only after dry-run exit and accepted live configuration.
- Agent registration/backstop instruction adoption: **pending**, only after canary/live acceptance through the normal instruction reviewer/applier.
- Rollback/revocation proof: **pending**; runbook specifies dryRun/disable, remove bindings/tool access, owner disables optional webhook, retain card backstops.

Do not erase the ledger to replay an unconfirmed wake or reinstall the old ownership heuristic as an automatic rollback. No installation or security exception is granted by merging source.
