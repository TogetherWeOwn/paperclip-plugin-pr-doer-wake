import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const secretRef = {
  type: "object",
  format: "secret-ref",
  required: ["type", "secretId"],
  additionalProperties: false,
  properties: {
    type: { const: "secret_ref" },
    secretId: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" },
    version: { anyOf: [{ type: "integer", minimum: 1 }, { const: "latest" }] },
  },
};

export const registrationTool = {
  name: "ci_wait_register",
  displayName: "Register CI completion wait",
  description: "After pushing an owned PR, register its exact issue, repository, PR number and head SHA. The caller must own the checkout, and the PR branch/repository must match the issue execution workspace. Repeated calls in one run are idempotent; after a manual rerun, register from a new run. Never guesses ownership from text or branches.",
  parametersSchema: {
    type: "object", additionalProperties: false,
    required: ["issueId", "repo", "prNumber", "headSha"],
    properties: {
      issueId: { type: "string", format: "uuid", maxLength: 36 },
      repo: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$", maxLength: 140 },
      prNumber: { type: "integer", minimum: 1, maximum: 2147483647 },
      headSha: { type: "string", pattern: "^[0-9a-f]{40}$", maxLength: 40 },
    },
  },
};

const manifest: PaperclipPluginManifestV1 = {
  id: "togetherweown.pr-doer-wake",
  apiVersion: 1,
  version: "0.2.0",
  displayName: "CI wake and PR custody",
  description: "Explicit CI completion waits plus opt-in hourly organization PR custody. Independent dry-run defaults, bounded native wakes and disposition cards; no automatic PR mutation.",
  author: "TogetherWeOwn",
  categories: ["automation"],
  capabilities: [
    "webhooks.receive", "jobs.schedule", "issues.read", "issues.wakeup", "issues.checkout",
    "execution.workspaces.read", "agent.tools.register", "plugin.state.read", "plugin.state.write",
    "http.outbound", "secrets.read-ref", "issues.create", "issue.documents.read", "issue.documents.write",
    "issue.relations.read", "projects.read", "project.workspaces.read", "database.namespace.read", "database.namespace.migrate",
  ],
  database: { namespaceSlug: "pr_custody", migrationsDir: "custody-migrations", coreReadTables: ["issues", "issue_comments", "issue_documents"] },
  entrypoints: { worker: "./dist/worker.js" },
  tools: [registrationTool],
  jobs: [
    { jobKey: "ci-wake-poll", displayName: "CI wait poll", description: "Recheck registered open waits without an LLM; retire moved heads and expired waits.", schedule: "*/4 * * * *" },
    { jobKey: "pr-custody", displayName: "PR custody", description: "Inventory organization PRs and request a disposition once per trigger. Separate opt-in and dry-run; incomplete evidence is UNKNOWN.", schedule: "17 * * * *" },
  ],
  webhooks: [{ endpointKey: "github-ci", displayName: "GitHub CI hint", description: "Optional phase two: signed check_suite completed events only. Disabled until explicitly configured; payloads never authorize a wake." }],
  instanceConfigSchema: {
    type: "object", additionalProperties: false,
    properties: {
      enabled: { type: "boolean", default: false },
      dryRun: { type: "boolean", default: true },
      custodyEnabled: { type: "boolean", default: false },
      custodyDryRun: { type: "boolean", default: true },
      custodyCompanyId: { type: "string", format: "uuid", description: "The one company whose cards custody may read/wake. No company enumeration." },
      custodyOrg: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9-]{0,38}$", description: "Organization whose non-archived repositories custody inventories. Separate from the CI registration allowlist." },
      custodySummaryAgentId: { type: "string", format: "uuid", description: "Accountable recipient for daily unmapped/bot inventory and unassigned-card follow-ups." },
      custodyClosedSince: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$", description: "Explicit initial closed-PR inventory boundary in UTC. Later ticks use the stored cursor; no pre-boundary coverage claimed." },
      allowedRepos: { type: "array", minItems: 0, maxItems: 100, uniqueItems: true, items: { type: "string", maxLength: 140, pattern: "^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$" }, default: [] },
      githubTokenSecretRef: { ...secretRef, description: "Existing read-only GitHub credential: pull requests, checks, commit statuses and branch rules/protection. Resolved only at call time." },
      webhooksEnabled: { type: "boolean", default: false },
      webhookSecretRef: { ...secretRef, description: "Phase two only: webhook HMAC secret stored by the owner in Paperclip." },
      repoMedianMs: { type: "object", maxProperties: 100, additionalProperties: { type: "integer", minimum: 60000, maximum: 86400000 }, description: "Optional measured per-repo cold-start CI medians in milliseconds; absent entries start at 30 minutes. Replaced by a rolling median of settled registered heads." },
    },
  },
};
export default manifest;
