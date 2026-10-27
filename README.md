# paperclip-plugin-pr-doer-wake

Paperclip plugin that wakes the card owning a GitHub pull request exactly once per (PR, head SHA, state) when its Paperclip Review lands below threshold, a required check really fails, a merge conflict appears, or it merges. Uses `ctx.issues.requestWakeup`, so blockers, terminal status and budgets are honoured by the host.
