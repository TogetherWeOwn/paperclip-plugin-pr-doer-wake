# togetherweown.pr-doer-wake

Wakes the Paperclip card that owns a GitHub pull request, exactly once per (PR, head SHA, state):

| state | trigger |
|---|---|
| `review_findings` | `check_run` completed, name `Paperclip Review`, conclusion `failure` (complete assessment below `ratingThreshold`, `githubReviewConclusion` in `server/src/services/chat-github-review-policy.ts:229`). `action_required` (admission refusal, incomplete) never wakes. |
| `ci_red` | `check_run` completed with `failure`, `timed_out` or `startup_failure` on the PR's current head (or a failed commit `status`). `cancelled`, `stale`, `skipped` and `neutral` never wake. `requiredChecks` narrows to required names per repo. |
| `conflict` | `push` to a repo's default branch marks it; the 5-minute job reads open-PR mergeability (one GraphQL page per repo) and wakes owners of `CONFLICTING` PRs. Also `pull_request` payloads that already say `mergeable_state: dirty`. |
| `merged` | `pull_request` closed with `merged: true`. |

Drafts never wake. The draft flag comes from `pull_request` webhooks; for a PR the plugin has not seen, one GraphQL lookup (only when `githubTokenSecretRef` is set), otherwise the signal is skipped.

## Why a plugin

Paperclip has no path from a PR result to the doer's card: `chat-github-checks.ts:25` "This outbox never schedules an agent", the review publish (`chat-github-reviews.ts:1371`) logs `chat_github.published`, which `activity-log.ts:17-45` does not forward to plugins, and external objects (`github-external-object-provider.ts`) only track open/merged/closed and wake nobody. GitHub webhooks into `POST /api/plugins/:pluginId/webhooks/github` are the intended plugin ingress (PLUGIN_SPEC.md section 18).

## Guarantees

- Exactly once: atomic `INSERT ... ON CONFLICT DO NOTHING` on `(company_id, fingerprint)` in the plugin's own namespace table `wake_ledger`.
- Holds: cards in `backlog`/`done`/`cancelled`, with an unresolved `blockedBy`, or (with `skipBlockedStatus`) in `blocked` get no comment and no wake. `ctx.issues.requestWakeup` re-checks assignee, terminal status, blockers and budget hard-stops on the host (`server/src/services/plugin-host-services.ts:2354-2372`).
- The evidence comment is plugin-authored; plugin comments never wake anyone (SDK `createComment` doc). The wake is `requestWakeup` with reason `github_pr_<state>`.
- `shadow: true` (the default) records `shadow:<card>` in the ledger and wakes nobody.

## Card resolution (interim)

Plugins cannot read `issue_work_products` (not in `PLUGIN_DATABASE_CORE_READ_TABLES`, `packages/shared/src/constants.ts:1442`). Until upstream adds it, the owner is:
1. the live card named by the head branch (`TOG-123-slug`), else
2. the live card whose own assignee first posted the exact PR URL in a comment (Reviewer and `chat_channel` cards excluded).

Measured against `issue_work_products` on 341 live PRs (2026-10-27): 302/326 linked PRs resolve to the same card, 17 resolve to none, 8 to another card.

## Config (per company)

`enabled`, `shadow`, `githubOrg`, `webhookSecretRef`, optional `githubTokenSecretRef`, `excludeAgentIds`, `requiredChecks`, `ignoreChecks`, `stoppedRepos`, `wakeStates`, `skipBlockedStatus`, `postEvidenceComment`, `branchIdentifierPattern`. See `src/manifest.ts`.

## Develop

`npm run check` (typecheck, vitest, build). The tests run the real SDK test harness and a verbatim copy of the host SQL validators (`tests/fixtures/host-sql-validator.ts`).

Local test setup used here: `npm install`, then copy the host SDK into `node_modules/@paperclipai/plugin-sdk` and `node_modules/@paperclipai/shared` (`docker cp paperclip:/app/packages/plugins/sdk/{dist,package.json}` and `.../shared/{dist,package.json}`, with `exports` set to their `publishConfig.exports` and dependencies removed).
