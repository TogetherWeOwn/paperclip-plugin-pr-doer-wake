import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { NAMESPACE_SLUG, PLUGIN_ID, PLUGIN_VERSION, SWEEP_JOB_KEY, WAKE_STATES, WEBHOOK_KEY } from "./constants.js";

/**
 * A Paperclip secret binding. `format: "secret-ref"` makes the host render a secret picker and bind the secret to
 * this plugin (PLUGIN_SPEC.md section 19.8; collectSecretRefPaths in server/src/services/json-schema-secret-refs.ts).
 * The picker stores the object `{ type: "secret_ref", secretId, version? }`, so the type stays "object": with
 * `type: "string"` the host's Ajv check (plugin-config-validator.ts) refuses that object ("must be string"), and a
 * bare UUID string is refused by the secrets handler. The `type: "string"` fields of the bundled sandbox providers
 * are environment config, which environment-config.ts converts before validating.
 */
const secretRef = {
  type: "object",
  format: "secret-ref",
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
    "Wakes the card that owns an open, non-draft GitHub pull request at most once per (PR, head SHA, state) when a check fails or a merge conflict appears on synchronize. Wakes go through ctx.issues.requestWakeup, so blockers, terminal status, assignee and budget hard-stops are enforced by the host.",
  author: "TogetherWeOwn",
  categories: ["automation"],
  capabilities: [
    "companies.read",
    "projects.read",
    "project.workspaces.read",
    "issues.read",
    "issue.relations.read",
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
    coreReadTables: ["issues", "issue_comments"],
  },
  webhooks: [
    {
      endpointKey: WEBHOOK_KEY,
      displayName: "GitHub organization webhook",
      description:
        "GitHub org webhook (content type application/json), events pull_request and check_run only, signed with the configured webhook secret. The host stores every delivery, so subscribe to nothing else.",
    },
  ],
  jobs: [
    {
      jobKey: SWEEP_JOB_KEY,
      displayName: "Wake retries",
      description:
        "Re-reads the PR and finishes wakes that failed, stalled or had no eligible owning card yet, with backoff; never repeats a wake that may already have reached the host. Compacts old settled rows into dedupe tombstones.",
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
      githubTokenSecretRef: {
        ...secretRef,
        description:
          "Required when enabled. Paperclip secret with a GitHub token that can read pull requests and check runs in githubOrg: a classic token (no scope for public repos, repo for private ones) or a token with Pull requests: read and Checks: read. Fine-grained personal access tokens cannot read check runs. Every wake is revalidated against GitHub first,.",
      },
      reviewCheckName: { type: "string", default: "Paperclip Review" },
      ignoreChecks: { type: "array", items: { type: "string" }, default: [] },
      stoppedRepos: { type: "array", items: { type: "string" }, default: ["togetherweown/nntune"], description: "Lowercase org/repo that never wake." },
      excludeAgentIds: { type: "array", items: { type: "string" }, default: [], description: "Agents whose cards never own a PR (the Reviewer)." },
      wakeStates: { type: "array", items: { type: "string", enum: [...WAKE_STATES] }, default: [...WAKE_STATES] },
      skipBlockedStatus: { type: "boolean", default: true },
      branchIdentifierPattern: { type: "string", default: "^([A-Z][A-Z0-9]*-[0-9]+)-" },
      trustedAuthors: {
        type: "array",
        items: { type: "string" },
        default: [],
        description: "PR author logins trusted besides OWNER/MEMBER/COLLABORATOR, e.g. the agents' GitHub App bot. Fork PRs are never trusted.",
      },
    },
  },
};

export default manifest;
