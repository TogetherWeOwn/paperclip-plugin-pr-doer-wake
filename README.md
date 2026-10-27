# togetherweown.pr-doer-wake

Wakes the Paperclip card that owns an open, non-draft GitHub pull request, once per (PR, head SHA, state):

| state | trigger |
|---|---|
| `review_findings` | `check_run` completed, name `Paperclip Review`, conclusion `failure` (complete assessment below `ratingThreshold`, `githubReviewConclusion` in `server/src/services/chat-github-review-policy.ts:229`). `action_required` (admission refusal, incomplete) never wakes. |
| `ci_red` | `check_run` completed with `failure`, `timed_out` or `startup_failure` on the PR's current head. `cancelled`, `stale`, `skipped` and `neutral` never wake. `requiredChecks` narrows to required names per repo. Commit `status` events are not consumed (see "Webhook events"). |
| `conflict` | `push` to a repo's default branch marks it; the 5-minute job reads open-PR mergeability (`sweepMaxPages` pages of 50 per repo per tick, default 4; a bigger repo resumes from the saved cursor next tick and logs a warning) and wakes owners of `CONFLICTING` PRs. Also `pull_request` payloads that already say `mergeable_state: dirty`, if GitHub still reports `CONFLICTING`. |

Drafts, closed and merged PRs, superseded heads, fork PRs and outsider authors never wake. There is no merged wake: a merged PR has nothing left to fix (an old config listing `merged` in `wakeStates` is ignored).

PR state: before any wake, the plugin reads the PR from GitHub GraphQL (`githubTokenSecretRef`, required when enabled) and wakes only if it is open, non-draft, trusted and still on the signal's head; for `conflict`, still `CONFLICTING`. Webhook payloads never authorize a wake: they arrive late, out of order and with tied `updated_at` values, and converting to draft or closing does not change the head. A failed or rate-limited lookup fails closed (claimed as `error`, re-read by the sweep). A redelivered red check that is already in the ledger costs no lookup.

Trust: a PR may name a card only if its head branch lives in the base repo (GraphQL `isCrossRepository: false`) and its author is `OWNER`, `MEMBER` or `COLLABORATOR`, or a login in `trustedAuthors` (bots report `NONE`; `[bot]` suffix and case are ignored).

## Webhook events

Subscribe the GitHub org webhook to exactly `pull_request`, `check_run` and `push` (content type `application/json`, secret = `webhookSecretRef`). Everything else is acknowledged without work, but still costs a stored row:

- Retention gap (host): `POST /api/plugins/:pluginId/webhooks/:endpointKey` inserts every delivery, headers and full payload, into `plugin_webhook_deliveries` before the worker sees it (`server/src/routes/plugins.ts` "Step 6"), and nothing in `server/src` prunes that table (only uninstall grace, PLUGIN_SPEC.md section 25). The plugin cannot filter before the insert, so the only lever here is the subscription list. Upstream note, not filed yet (search existing issues first per CONTRIBUTING.md): a retention window for `plugin_webhook_deliveries` (age or count per plugin), or an optional manifest-declared event allowlist the route checks before inserting.
- The route is public and also accepts the plugin key instead of the id (`resolvePlugin`, `routes/plugins.ts:377`), so anyone can POST to it. Deliveries are pre-filtered (`mayAct`), signatures must be well-formed `sha256=<64 hex>`, and verification uses a worker-memory copy of the webhook secret (`src/secrets.ts`: 10-minute TTL, keyed company + config path + secret id + version). One resolution per key runs at a time and concurrent deliveries await it (the SDK dispatches host requests concurrently). A value past its TTL still verifies (an HMAC match proves authenticity) and schedules one background re-resolution, which replaces it when the secret was rotated. Only a verification miss re-resolves on the request path, at most once per minute per company, so forged traffic cannot drain the host's 30-per-minute secret-resolution limit (`plugin-secrets-handler.ts:195`), which every secret of this plugin shares. The GitHub token shares the cache; after an HTTP 401 it is not re-resolved for 5 minutes (lookups meanwhile are transient and retried by the sweep), so a dead token cannot spend the webhook secret's budget.

## Why a plugin

Paperclip has no path from a PR result to the doer's card: `chat-github-checks.ts:25` "This outbox never schedules an agent", the review publish (`chat-github-reviews.ts:1371`) logs `chat_github.published`, which `activity-log.ts:17-45` does not forward to plugins, and external objects (`github-external-object-provider.ts`) only track open/merged/closed and wake nobody. GitHub webhooks into `POST /api/plugins/:pluginId/webhooks/github` are the intended plugin ingress (PLUGIN_SPEC.md section 18).

## Guarantees

- Exactly once: atomic `INSERT ... ON CONFLICT DO NOTHING` on `(company_id, fingerprint)` in the plugin's own namespace table `wake_ledger`.
- Retries: the sweep finishes rows at `error` (after 2 minutes) and rows stuck at `claimed` (after 10 minutes, the worker stopped mid-wake), up to 5 attempts. Before every retry it re-reads the PR from GitHub: draft, closed, merged, re-pushed or untrusted PRs end as `stale:<reason>` and are never woken. A PR lookup that fails transiently (GitHub 5xx, secret rate limit) is claimed as `error` and re-read by the sweep instead of dropped.
- Phases: `comment_posted_at` and `wake_attempted_at` (migration 002) record what an attempt already did. A retry posts the evidence comment only if neither the phase nor an identical comment on the card exists. The host does not dedupe plugin wakes by `idempotencyKey` (it is stored, but `server/src/services/heartbeat/queue.ts` only checks it for `execution-reconciliation:` keys), so a retry after an ambiguous `requestWakeup` first looks in `heartbeat_runs` for a run on the card with this plugin's `contextSnapshot.source` and wake reason created since the attempt, and records that run instead of waking again.
- Holds: cards in `backlog`/`done`/`cancelled`, with an unresolved `blockedBy`, or (with `skipBlockedStatus`) in `blocked` get no comment and no wake. `ctx.issues.requestWakeup` re-checks assignee, terminal status, blockers and budget hard-stops on the host (`server/src/services/plugin-host-services.ts:2354-2372`).
- The evidence comment is plugin-authored; plugin comments never wake anyone (SDK `createComment` doc). The wake is `requestWakeup` with reason `github_pr_<state>`.
- `shadow: true` (the default) records `shadow:<card>` in the ledger and wakes nobody.

## Card resolution (interim)

Core reads: `issues`, `issue_comments` (card resolution, evidence-comment check) and `heartbeat_runs` (ambiguous-wake check). Plugins cannot read `issue_work_products` (not in `PLUGIN_DATABASE_CORE_READ_TABLES`, `packages/shared/src/constants.ts:1442`). Until upstream adds it, the owner is:
1. the live card named by the head branch (`TOG-123-slug`), else
2. the live card whose own assignee first posted the exact PR URL in a comment (Reviewer and `chat_channel` cards excluded).

Measured against `issue_work_products` on 341 live PRs (2026-10-27): 302/326 linked PRs resolve to the same card, 17 resolve to none, 8 to another card.

## Config (per company)

`enabled`, `shadow`, `githubOrg`, `webhookSecretRef`, `githubTokenSecretRef` (both required when enabled), `excludeAgentIds`, `requiredChecks`, `ignoreChecks`, `stoppedRepos`, `wakeStates`, `skipBlockedStatus`, `postEvidenceComment`, `branchIdentifierPattern`, `trustedAuthors`, `sweepMaxPages`. See `src/manifest.ts`.

## Upgrading from 0.1.1

Set `githubTokenSecretRef` before upgrading: an enabled company without it fails config validation and is ignored. The `pr` plugin-state entries 0.1.1 wrote (the webhook PR index) are no longer read and are inert.

## Develop

`npm run check` (typecheck, vitest, build). The tests run the real SDK test harness and a verbatim copy of the host SQL validators (`tests/fixtures/host-sql-validator.ts`).

Local test setup used here: `npm install`, then copy the host SDK into `node_modules/@paperclipai/plugin-sdk` and `node_modules/@paperclipai/shared` (`docker cp paperclip:/app/packages/plugins/sdk/{dist,package.json}` and `.../shared/{dist,package.json}`, with `exports` set to their `publishConfig.exports` and dependencies removed).
