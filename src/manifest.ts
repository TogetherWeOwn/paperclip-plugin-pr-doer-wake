import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { NAMESPACE_SLUG, PLUGIN_ID, PLUGIN_VERSION, SWEEP_JOB_KEY, WAKE_STATES, WEBHOOK_KEY } from "./constants.js";

const secretRef = {
  type: "object",
  required: ["type", "secretId"],
  additionalProperties: true,
  properties: { type: { const: "secret_ref" }, secretId: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" } },
};

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "PR doer wake",
  description:
    "Wakes the card that owns a GitHub pull request exactly once per (PR, head SHA, state) when its Paperclip Review lands below threshold, a gating check really fails, a merge conflict appears or it merges. Wakes go through ctx.issues.requestWakeup, so blockers, terminal status, assignee and budget hard-stops are enforced by the host.",
  author: "TogetherWeOwn",
  categories: ["automation"],
  capabilities: [
    "companies.read",
    "issues.read",
    "issue.relations.read",
    "issue.comments.create",
    "issues.wakeup",
    "plugin.state.read",
    "plugin.state.write",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "webhooks.receive",
    "secrets.read-ref",
    "http.outbound",
    "jobs.schedule",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  database: {
    namespaceSlug: NAMESPACE_SLUG,
    migrationsDir: "migrations",
    // heartbeat_runs: a retry checks whether the earlier, ambiguous requestWakeup already created a run.
    coreReadTables: ["issues", "issue_comments", "heartbeat_runs"],
  },
  webhooks: [
    {
      endpointKey: WEBHOOK_KEY,
      displayName: "GitHub organization webhook",
      description:
        "GitHub org webhook (content type application/json), events pull_request, check_run and push only, signed with the configured webhook secret. The host stores every delivery, so subscribe to nothing else.",
    },
  ],
  jobs: [
    {
      jobKey: SWEEP_JOB_KEY,
      displayName: "Conflict sweep and wake retries",
      description:
        "For repos whose default branch moved, reads open PR mergeability (up to sweepMaxPages GraphQL pages per repo per tick, resuming from the cursor) and wakes owners of newly conflicting non-draft PRs; re-reads the PR and finishes wakes that failed or stalled; prunes the ledger after 30 days.",
      schedule: "*/5 * * * *",
    },
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      enabled: { type: "boolean", default: false, description: "Master switch for this company." },
      shadow: { type: "boolean", default: true, description: "Record and log what would be woken, but post nothing and wake nobody." },
      githubOrg: { type: "string", description: "GitHub organization login whose webhooks this company accepts, e.g. TogetherWeOwn." },
      webhookSecretRef: { ...secretRef, description: "Paperclip secret holding the GitHub webhook secret." },
      githubTokenSecretRef: { ...secretRef, description: "Optional Paperclip secret with a read-only GitHub token (pull requests: read). Enables the conflict sweep and draft lookups." },
      reviewCheckName: { type: "string", default: "Paperclip Review" },
      requiredChecks: {
        type: "object",
        additionalProperties: { type: "array", items: { type: "string" } },
        default: {},
        description: "Lowercase org/repo -> check names that gate it. Repos without an entry treat every check except ignoreChecks as gating.",
      },
      ignoreChecks: { type: "array", items: { type: "string" }, default: [] },
      stoppedRepos: { type: "array", items: { type: "string" }, default: [], description: "Lowercase org/repo that never wake." },
      excludeAgentIds: { type: "array", items: { type: "string" }, default: [], description: "Agents whose cards never own a PR (the Reviewer)." },
      wakeStates: { type: "array", items: { type: "string", enum: [...WAKE_STATES] }, default: [...WAKE_STATES] },
      skipBlockedStatus: { type: "boolean", default: true },
      postEvidenceComment: { type: "boolean", default: true },
      branchIdentifierPattern: { type: "string", default: "^([A-Z][A-Z0-9]*-[0-9]+)-" },
      trustedAuthors: {
        type: "array",
        items: { type: "string" },
        default: [],
        description: "PR author logins trusted besides OWNER/MEMBER/COLLABORATOR, e.g. the agents' GitHub App bot. Fork PRs are never trusted.",
      },
      sweepMaxPages: { type: "integer", minimum: 1, maximum: 20, default: 4, description: "Open-PR pages (50 each) the conflict sweep reads per repo per tick." },
    },
  },
};

export default manifest;
