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
  description: "After pushing an owned PR, register its exact issue, repository, PR number and head SHA. Send exactly four fields: issueId (the Paperclip issue UUID, not the TWO-#### identifier), repo (owner/repo; a github.com URL is also accepted), prNumber (integer; a digit string is also accepted), headSha (full 40-character commit SHA, e.g. from `git rev-parse HEAD`; uppercase hex is accepted and lowercased). The caller must own the checkout; binding is the execution workspace identity plus the live PR number and head SHA — the PR head branch need not equal the workspace branch name. Repeated calls in one run are idempotent; after a manual rerun, register from a new run. Refusals return an enumerated secret-free code plus a safe reason in the tool result content; the reason names the received field shapes (types/lengths only, never values). Never guesses ownership from text or branches.",
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
  version: "0.3.0",
  displayName: "CI wake and PR custody",
  description: "Explicit CI completion waits. PR custody is unavailable pending a safe cutover; manual custody jobs are rejected.",
  author: "TogetherWeOwn",
  categories: ["automation"],
  capabilities: [
    "webhooks.receive", "jobs.schedule", "issues.read", "issues.wakeup", "issues.checkout",
    "execution.workspaces.read", "agent.tools.register", "plugin.state.read", "plugin.state.write",
    "http.outbound", "secrets.read-ref", "issues.create", "issue.documents.read", "issue.documents.write",
"issue.relations.read", "projects.read", "project.workspaces.read", "database.namespace.read", "database.namespace.migrate",
    "events.subscribe", "issue.interactions.read", "issues.orchestration.read",
  ],
  database: { namespaceSlug: "pr_custody", migrationsDir: "custody-migrations", coreReadTables: ["issues", "issue_comments", "issue_documents"] },
  entrypoints: { worker: "./dist/worker.js" },
  tools: [registrationTool],
  jobs: [
    { jobKey: "ci-wake-poll", displayName: "CI wait poll", description: "Backstop recheck of registered open waits without an LLM; webhooks are the primary trigger. Retires moved heads and expired waits.", schedule: "*/15 * * * *" },
    { jobKey: "gates-status-sweep", displayName: "Gates status sweep", description: "Publish paperclip/gates commit statuses from RM merge confirmations. Ships disabled; shadow mode logs only.", schedule: "*/4 * * * *" },
    { jobKey: "pr-custody", displayName: "PR custody", description: "Unavailable pending a safe cutover; manual runs are rejected." },
    { jobKey: "dependency-wake", displayName: "Dependency wake", description: "Wake in_review/in_progress dependents once per (dependent, blocker completion) after every blocker is done for 10 minutes, the assignee has not run since, and no run is live. Ships disabled and shadow-only; dryRun forces shadow.", schedule: "*/5 * * * *" },
  ],
  webhooks: [{ endpointKey: "github-ci", displayName: "GitHub CI hint", description: "Phase two (push mode): signed check_suite, check_run, workflow_run and pull_request events only. Disabled until explicitly configured; payloads never authorize a wake, they trigger a fresh GitHub recheck of an already-registered wait." }],
  instanceConfigSchema: {
    type: "object", additionalProperties: false,
    allOf: [
      { if: { anyOf: ["githubAppId", "githubInstallationId", "githubAppPrivateKeySecretRef"].map((key) => ({ required: [key] })) }, then: { required: ["githubAppId", "githubInstallationId", "githubAppPrivateKeySecretRef"], not: { required: ["githubTokenSecretRef"] } } },
      { if: { anyOf: [{ required: ["enabled"], properties: { enabled: { const: true } } }, { required: ["gatesStatusEnabled"], properties: { gatesStatusEnabled: { const: true } } }, { required: ["prHeadWakeEnabled"], properties: { prHeadWakeEnabled: { const: true } } }] }, then: { anyOf: [{ required: ["githubTokenSecretRef"] }, { required: ["githubAppId", "githubInstallationId", "githubAppPrivateKeySecretRef"] }] } },
      { if: { required: ["dependencyWakeEnabled"], properties: { dependencyWakeEnabled: { const: true } } }, then: { required: ["dependencyWakeCompanyId"] } },
    ],
    properties: {
      enabled: { type: "boolean", default: false },
      dryRun: { type: "boolean", default: true },
      custodyEnabled: { type: "boolean", default: false },
      custodyDryRun: { type: "boolean", default: true },
      custodyCompanyId: { type: "string", format: "uuid", description: "The one company whose cards custody may read/wake. No company enumeration." },
      custodyOrg: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9-]{0,38}$", description: "Organization whose non-archived repositories custody inventories. Separate from the CI registration allowlist." },
      custodySummaryAgentId: { type: "string", format: "uuid", description: "Accountable recipient for daily unmapped/bot inventory and unassigned-card follow-ups." },
      custodyClosedSince: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$", description: "Explicit initial closed-PR inventory boundary in UTC. Later ticks use the stored cursor; no pre-boundary coverage claimed." },
      allowedRepos: { type: "array", minItems: 0, maxItems: 200, uniqueItems: true, items: { type: "string", maxLength: 140, pattern: "^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$" }, default: [] },
      githubTokenSecretRef: { ...secretRef, description: "Bearer mode only: existing read-only GitHub token. Mutually exclusive with the three App settings; resolved at call time." },
      githubAppId: { type: "string", pattern: "^[1-9][0-9]{0,15}$", description: "App mode: numeric App ID as a decimal string, not a client secret." },
      githubInstallationId: { type: "string", pattern: "^[1-9][0-9]{0,15}$", description: "App mode: existing approved installation ID as a decimal string." },
      githubAppPrivateKeySecretRef: { ...secretRef, description: "App mode: existing approved RSA private-key reference. All three App fields are required. Tokens are narrowed to one allowed repository and fixed read permissions." },
      prHeadWakeEnabled: { type: "boolean", default: false, description: "Wake pending reviewers (in_review, pending stage) when their PR head changes and settles. Ships disabled; enables a bounded per-(card,SHA) wake only, never status/assignment writes." },
      prHeadWakeShadow: { type: "boolean", default: true, description: "Shadow mode: compute and log intended pr_head_changed wakes without firing any. Set false only after shadow evidence is accepted." },
      gatesStatusEnabled: { type: "boolean", default: false, description: "Publish paperclip/gates commit statuses from RM merge confirmations. Stays off until the App gains statuses: write; without it the publisher logs missing_permission and never greens a SHA." },
      gatesStatusShadow: { type: "boolean", default: true, description: "Shadow mode: compute and log decisions without POSTing any GitHub status. Set false only after shadow evidence matches RM decisions." },
      releaseManagerAgentId: { type: "string", format: "uuid", description: "The one agent addressed by and resolving merge-authorization confirmations (title Merge <owner/repo>#<n>?, prompt identical, bare-PR-URL details) that publish paperclip/gates. Required when gatesStatusEnabled is true." },
      dependencyWakeEnabled: { type: "boolean", default: false, description: "Wake in_review/in_progress dependents whose blockers are all done (core re-wakes only blocked dependents after a gated finalize). Ships disabled; needs no GitHub credential." },
      dependencyWakeShadow: { type: "boolean", default: true, description: "Shadow mode: record and log intended dependency wakes without firing any. dryRun: true also forces shadow. Set false only after shadow evidence is accepted." },
      dependencyWakeCompanyId: { type: "string", format: "uuid", description: "The one company whose cards dependency wake may read and wake. Required when dependencyWakeEnabled is true." },
      webhooksEnabled: { type: "boolean", default: false },
      webhookSecretRef: { ...secretRef, description: "Phase two only: webhook HMAC secret stored by the owner in Paperclip." },
      repoMedianMs: { type: "object", maxProperties: 200, additionalProperties: { type: "integer", minimum: 60000, maximum: 86400000 }, description: "Optional measured per-repo cold-start CI medians in milliseconds; absent entries start at 30 minutes. Replaced by a rolling median of settled registered heads." },
    },
  },
};
export default manifest;
