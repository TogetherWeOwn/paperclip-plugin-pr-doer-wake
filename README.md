# togetherweown.pr-doer-wake

Wakes the Paperclip card that owns a GitHub pull request, exactly once per (PR, head SHA, state):

| state | trigger |
|---|---|
| `review_findings` | `check_run` completed, name `Paperclip Review`, conclusion `failure` (complete assessment below `ratingThreshold`, `githubReviewConclusion` in `server/src/services/chat-github-review-policy.ts:229`). `action_required` (admission refusal, incomplete) never wakes. |
| `ci_red` | `check_run` completed with `failure`, `timed_out` or `startup_failure` on the PR's current head. `cancelled`, `stale`, `skipped` and `neutral` never wake. `requiredChecks` narrows to required names per repo. Commit `status` events are not consumed (see "Webhook events"). |
| `conflict` | `push` to a repo's default branch marks it; the 5-minute job reads open-PR mergeability (`sweepMaxPages` pages of 50 per repo per tick, default 4; a bigger repo resumes from the saved cursor next tick and logs a warning) and wakes owners of `CONFLICTING` PRs. Also `pull_request` payloads that already say `mergeable_state: dirty`. |
| `merged` | `pull_request` closed with `merged: true`. |

Drafts, closed PRs, superseded heads, fork PRs and outsider authors never wake. The PR index (plugin state) comes from `pull_request` webhooks and GraphQL lookups; for a PR the plugin has not seen, one GraphQL lookup (only when `githubTokenSecretRef` is set), otherwise the signal is skipped. The index stores `updated_at`, so an out-of-order or replayed delivery never overwrites newer data, and closed PRs stay as tombstones so a late delivery cannot reopen them.

Trust: a PR may name a card only if its head branch lives in the base repo (`head.repo` = `base.repo`, GraphQL `isCrossRepository: false`) and its author is `OWNER`, `MEMBER` or `COLLABORATOR`, or a login in `trustedAuthors` (bots report `NONE`; `[bot]` suffix and case are ignored). `check_run.pull_requests` already omits fork PRs.

## Webhook events

Subscribe the GitHub org webhook to exactly `pull_request`, `check_run` and `push` (content type `application/json`, secret = `webhookSecretRef`). Everything else is acknowledged without work, but still costs a stored row:

- Retention gap (host): `POST /api/plugins/:pluginId/webhooks/:endpointKey` inserts every delivery, headers and full payload, into `plugin_webhook_deliveries` before the worker sees it (`server/src/routes/plugins.ts` "Step 6"), and nothing in `server/src` prunes that table (only uninstall grace, PLUGIN_SPEC.md section 25). The plugin cannot filter before the insert, so the only lever here is the subscription list. Upstream note, not filed yet (search existing issues first per CONTRIBUTING.md): a retention window for `plugin_webhook_deliveries` (age or count per plugin), or an optional manifest-declared event allowlist the route checks before inserting.
- The route is public and also accepts the plugin key instead of the id (`resolvePlugin`, `routes/plugins.ts:377`), so anyone can POST to it. Deliveries are pre-filtered (`mayAct`), signatures must be well-formed `sha256=<64 hex>`, and verification uses a worker-memory copy of the webhook secret (`src/secrets.ts`: 10-minute TTL, keyed company + config path + secret id + version). Only a verification miss re-resolves, at most once per minute per company, so forged traffic cannot drain the host's 30-per-minute secret-resolution limit (`plugin-secrets-handler.ts:195`). A rotated secret is picked up on the first real delivery after that minute. The GitHub token shares the cache and is dropped on HTTP 401.

## Why a plugin

Paperclip has no path from a PR result to the doer's card: `chat-github-checks.ts:25` "This outbox never schedules an agent", the review publish (`chat-github-reviews.ts:1371`) logs `chat_github.published`, which `activity-log.ts:17-45` does not forward to plugins, and external objects (`github-external-object-provider.ts`) only track open/merged/closed and wake nobody. GitHub webhooks into `POST /api/plugins/:pluginId/webhooks/github` are the intended plugin ingress (PLUGIN_SPEC.md section 18).

## Guarantees

- Exactly once: atomic `INSERT ... ON CONFLICT DO NOTHING` on `(company_id, fingerprint)` in the plugin's own namespace table `wake_ledger`.
- Retries: the sweep finishes rows at `error` (after 2 minutes) and rows stuck at `claimed` (after 10 minutes, the worker stopped mid-wake), up to 5 attempts. Before every retry it re-reads the PR (GraphQL when a token is set, else the index): draft, closed, merged, re-pushed or untrusted PRs end as `stale:<reason>` and are never woken. A PR lookup that fails transiently (GitHub 5xx, secret rate limit) is claimed as `error` and re-read by the sweep instead of dropped.
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

`enabled`, `shadow`, `githubOrg`, `webhookSecretRef`, optional `githubTokenSecretRef`, `excludeAgentIds`, `requiredChecks`, `ignoreChecks`, `stoppedRepos`, `wakeStates`, `skipBlockedStatus`, `postEvidenceComment`, `branchIdentifierPattern`, `trustedAuthors`, `sweepMaxPages`. See `src/manifest.ts`.

## Develop

`npm run check` (typecheck, vitest, build). The tests run the real SDK test harness and a verbatim copy of the host SQL validators (`tests/fixtures/host-sql-validator.ts`).

Local test setup used here: `npm install`, then copy the host SDK into `node_modules/@paperclipai/plugin-sdk` and `node_modules/@paperclipai/shared` (`docker cp paperclip:/app/packages/plugins/sdk/{dist,package.json}` and `.../shared/{dist,package.json}`, with `exports` set to their `publishConfig.exports` and dependencies removed).
