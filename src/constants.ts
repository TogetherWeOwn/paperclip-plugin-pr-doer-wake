export const PLUGIN_ID = "togetherweown.pr-doer-wake";
export const PLUGIN_VERSION = "0.1.2";
export const NAMESPACE_SLUG = "pr_doer_wake";
/** derivePluginDatabaseNamespace(PLUGIN_ID, NAMESPACE_SLUG) in /app/server/src/services/plugin-database.ts:31. */
export const DB_NAMESPACE = "plugin_pr_doer_wake_2a97cdbae1";
export const WEBHOOK_KEY = "github";
export const SWEEP_JOB_KEY = "pr-doer-wake-sweep";
export const CONTEXT_SOURCE = "plugin.pr-doer-wake";

export const WAKE_STATES = ["review_findings", "ci_red", "conflict", "merged"] as const;
export type WakeState = (typeof WAKE_STATES)[number];
