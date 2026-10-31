# PR doer wake

A Paperclip plugin that wakes the owner of an open, non-draft, trusted GitHub PR through `ctx.issues.requestWakeup`. It does not create comments. The host remains authoritative for assignee, blockers, status, agent state, and budget. Shadow mode records the decision without a wake.

## Events and limitations

Keep the existing organization webhook id **703712015**, plugin id `togetherweown.pr-doer-wake`, and endpoint key `github`. Subscribe only to `check_run` and `pull_request`; keep the existing signed endpoint and secret. The plugin accepts completed check runs with conclusions `failure`, `timed_out` or `action_required`, and pull request `synchronize` events as candidates for conflicts. It re-reads GitHub and only wakes for a currently red check or `CONFLICTING` mergeability. `UNKNOWN` is retried. `closed` events verify current PR state and clear never-attempted ledger rows; wake-attempted tombstones are retained for deduplication. Other events and conclusions do not trigger a wake.

A default-branch push is no longer consumed: conflicts caused only by a base branch update are not noticed until a relevant synchronize event. Checks that fail while a PR is a draft or closed are not rechecked merely because it becomes ready or reopens. Commit status events are not consumed.

## Card resolution

All available ownership evidence is considered before eligibility: branch identifier, PR URL in an agent-authored comment, and PR URL in a card title or description. More than one distinct candidate is ambiguous and held. A branch identifier counts only when the named card's project has a workspace for the PR's repository; a card-named branch in an unrelated repository names no card. Once two candidates are found the description scan is skipped. Comment matching excludes comments by configured excluded agents, users, plugins, and chat-channel cards. URL matching requires the GitHub PR URL as a token, with a non-digit after the PR number. The SDK issue list has no text search, so the plugin discovers matching projects from their workspace GitHub repository URLs, lists only their open issues by status, and fetches full descriptions (the list returns previews). It reads at most 200 full issues and checks at most 200 projects; if either cap is exceeded it holds the wake as ambiguous, even when a branch or comment matches. No matching workspace means title/description evidence is unavailable; projectless and terminal cards are not scanned for this evidence. Keep workspace repository URLs current. The repository-to-projects map and full issue texts (keyed by issue `updatedAt`) are reused for 60 seconds, so a new workspace link may take up to a minute to count. The host applies pagination twice (`/app/server/src/services/plugin-host-services.ts` `applyWindow` and `/app/server/src/services/issues.ts` `list`), so the bounded scan uses no offset.

**Known gap:** Work-product matching is not implemented. The pinned SDK/host exposes no plugin work-product read (`/app/server/src/services/plugin-host-services.ts:2060`, `/app/packages/shared/src/constants.ts:1442`). Follow up upstream for a supported plugin work-product read after searching existing issues, then use it as another ownership signal. Until then a card linked only by a work product is not found, and a single wrong candidate cannot be detected.

## Delivery contract

The ledger deduplicates by company, PR, head SHA and state. A fenced atomic mark precedes the wake request. If a request may have reached the host but its reply is lost, it is not repeated, and the row is recorded as `wake_unconfirmed`: this provides at-most-once requests, not guaranteed delivery. Transient failures retry with backoff without limit. Unresolved owners (`no_card`) retry with backoff for 8 attempts (about 4 hours), after which only a later genuine signal for the same head and state resumes them; terminal holds and ambiguity are not polled. GitHub revalidation prevents stale heads, closed or merged PRs, drafts, forks, outsiders and recovered checks from waking. A closed event arriving after reopening is ignored after the current-state check. A concurrent close after the last GitHub read cannot be made atomic with a wake.

## Configuration

See `src/manifest.ts`. `enabled` defaults false and `shadow` true. Enabled companies require `githubOrg`, `webhookSecretRef`, and `githubTokenSecretRef` Paperclip secret references. The GitHub token must read PRs and check runs; fine-grained personal access tokens cannot obtain Checks permission, so use a suitable classic token or another supported token. `stoppedRepos` defaults to `["togetherweown/nntune"]` when omitted; an explicit list replaces the default. `ignoreChecks` excludes check names, including the review check. There is no static required-checks map: every non-ignored check is considered, including optional checks. Existing `requiredChecks` and `postEvidenceComment` settings are ignored. Other controls include `excludeAgentIds`, `wakeStates`, `skipBlockedStatus`, `branchIdentifierPattern`, `reviewCheckName`, and `trustedAuthors`.

The webhook signature is checked against the raw body using the configured secret; non-actionable events are discarded before secret resolution. Both GitHub secrets use the worker-memory cache described in `src/secrets.ts`.

## Development

Run `npm ci && npm run check` for typecheck, Vitest and build. SQL and config contract tests use the host validators copied into `tests/fixtures/`.
