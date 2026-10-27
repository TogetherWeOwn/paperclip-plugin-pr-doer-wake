import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import manifest from "../src/manifest.js";
import { DB_NAMESPACE, NAMESPACE_SLUG, PLUGIN_ID } from "../src/constants.js";
import {
  CARD_BY_COMMENT_SQL,
  CARD_BY_IDENTIFIER_SQL,
  COMMENT_EXISTS_SQL,
  claimSql,
  compactSql,
  forgetSql,
  markCommentPostedSql,
  markWakeAttemptedSql,
  prUrlPatterns,
  reclaimSql,
  recordOutcomeSql,
  releaseWakeAttemptSql,
  retryableSql,
  seenSql,
} from "../src/sql.js";
import {
  derivePluginDatabaseNamespace,
  splitSqlStatements,
  validatePluginMigrationStatement,
  validatePluginRuntimeExecute,
  validatePluginRuntimeQuery,
} from "./fixtures/host-sql-validator.js";
import { collectSecretRefPaths, validateInstanceConfig } from "./fixtures/host-config-validator.js";

const core = manifest.database!.coreReadTables!;

describe("host contract", () => {
  it("manifest passes the host's pluginManifestV1Schema", () => {
    const result = pluginManifestV1Schema.safeParse(manifest);
    if (!result.success) console.error(JSON.stringify(result.error.issues, null, 1));
    expect(result.success).toBe(true);
  });
  it("namespace constant equals the host derivation", () => {
    expect(derivePluginDatabaseNamespace(PLUGIN_ID, NAMESPACE_SLUG)).toBe(DB_NAMESPACE);
  });
  it("migrations pass the host migration validator", () => {
    for (const [file, count] of [["001_wake_ledger.sql", 2], ["002_wake_phases.sql", 2]] as const) {
      const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      const statements = splitSqlStatements(sql);
      expect(statements.length).toBe(count);
      for (const s of statements) expect(() => validatePluginMigrationStatement(s, DB_NAMESPACE, core)).not.toThrow();
    }
  });
  it("reads only issues and issue_comments from core", () => {
    expect([...core].sort()).toEqual(["issue_comments", "issues"]);
  });
  it("runtime queries pass validatePluginRuntimeQuery with the declared core tables only", () => {
    for (const q of [CARD_BY_IDENTIFIER_SQL, CARD_BY_COMMENT_SQL, COMMENT_EXISTS_SQL, retryableSql(DB_NAMESPACE), seenSql(DB_NAMESPACE)]) {
      expect(() => validatePluginRuntimeQuery(q, DB_NAMESPACE, core)).not.toThrow();
    }
    expect(() => validatePluginRuntimeQuery(CARD_BY_COMMENT_SQL, DB_NAMESPACE, ["issues"])).toThrow(/issue_comments/);
  });
  it("retries failed and card-pending rows with exponential backoff (2..60 minutes) and rows stuck at claimed or retrying", () => {
    const sql = retryableSql(DB_NAMESPACE);
    // The exponent is capped too: retries never end, and power(2, attempts) overflows float8 past ~1023 attempts.
    expect(sql).toMatch(/outcome in \('error', 'no_card'\) and updated_at < now\(\) - interval '1 minute' \* least\(power\(2, least\(attempts, 5\) \+ 1\), 60\)/);
    expect(sql).toMatch(/outcome in \('claimed', 'retrying'\) and updated_at < now\(\) - interval '10 minutes'/);
    // No attempt cap: a pending row is retried hourly until GitHub answers, never dropped (plugin.ts retryRow).
    expect(sql).not.toMatch(/attempts </);
    expect(sql).toMatch(/signal <> '\{\}'::jsonb/); // compacted tombstones are never retried
    expect(sql).toMatch(/updated_at::text as updated_at/);
  });
  it("the wake mark is the atomic gate before requestWakeup, and a release undoes only its own mark", () => {
    expect(markWakeAttemptedSql(DB_NAMESPACE)).toMatch(/set wake_attempted_at = \$4::timestamptz, issue_id = \$3, updated_at = now\(\)\s+where company_id = \$1 and fingerprint = \$2 and wake_attempted_at is null$/);
    expect(releaseWakeAttemptSql(DB_NAMESPACE)).toMatch(/where company_id = \$1 and fingerprint = \$2 and wake_attempted_at = \$3::timestamptz$/);
  });
  it("forgetting a row never touches one whose wake may have reached the host", () => {
    expect(forgetSql(DB_NAMESPACE)).toMatch(/^delete from \S+\.wake_ledger\s+where company_id = \$1 and fingerprint = \$2 and wake_attempted_at is null$/);
  });
  it("the dedupe pre-check returns what a redelivery needs to resume a never-attempted row", () => {
    expect(seenSql(DB_NAMESPACE)).toMatch(/outcome, attempts, updated_at::text as updated_at, signal::text as signal/);
    expect(seenSql(DB_NAMESPACE)).toMatch(/wake_attempted_at::text as wake_attempted_at/);
  });
  it("a retry re-claims its row with a conditional UPDATE on the selected outcome and updated_at", () => {
    const sql = reclaimSql(DB_NAMESPACE);
    expect(sql).toMatch(/set outcome = 'retrying', attempts = attempts \+ 1/);
    expect(sql).toMatch(/where company_id = \$1 and fingerprint = \$2 and outcome = \$3 and updated_at::text = \$4/);
  });
  it("retention compacts aged rows into dedupe tombstones and never deletes them", () => {
    const sql = compactSql(DB_NAMESPACE);
    expect(sql).not.toMatch(/delete/i);
    expect(sql).toMatch(/set signal = '\{\}'::jsonb/);
    expect(sql).toMatch(/updated_at < now\(\) - interval '30 days'/);
  });
  it("ownership lookups do not filter on status or the card's eligibility", () => {
    expect(CARD_BY_IDENTIFIER_SQL).not.toMatch(/status not in|assignee_agent_id is not null|string_to_array/);
    expect(CARD_BY_COMMENT_SQL).not.toMatch(/status not in/);
    // The card's CURRENT assignee never decides ownership: reassigning the owner must not promote a later card.
    expect(CARD_BY_COMMENT_SQL).not.toMatch(/assignee_agent_id/);
    expect(CARD_BY_COMMENT_SQL).toMatch(/c\.author_agent_id is not null and not \(c\.author_agent_id::text = any\(string_to_array\(\$4, ','\)\)\)/);
    // Up to two distinct cards: a second one makes ownership ambiguous (waker.ts resolveCard), never "the first".
    expect(CARD_BY_COMMENT_SQL).toMatch(/group by i\.id, i\.identifier, i\.status\s+order by i\.id\s+limit 2$/);
    expect(CARD_BY_COMMENT_SQL).not.toMatch(/first_mention|min\(/);
  });
  it("runtime writes pass validatePluginRuntimeExecute", () => {
    for (const q of [claimSql(DB_NAMESPACE), reclaimSql(DB_NAMESPACE), recordOutcomeSql(DB_NAMESPACE), markCommentPostedSql(DB_NAMESPACE), markWakeAttemptedSql(DB_NAMESPACE), releaseWakeAttemptSql(DB_NAMESPACE), forgetSql(DB_NAMESPACE), compactSql(DB_NAMESPACE)]) {
      expect(() => validatePluginRuntimeExecute(q, DB_NAMESPACE)).not.toThrow();
    }
  });
});

describe("secret config fields (PLUGIN_SPEC.md section 19.8)", () => {
  const schema = manifest.instanceConfigSchema as Record<string, any>;
  const binding = { type: "secret_ref", secretId: "00000000-0000-4000-8000-000000000001" };
  it("are annotated format: secret-ref, so the host renders a secret picker and binds them", () => {
    expect([...collectSecretRefPaths(schema)].sort()).toEqual(["githubTokenSecretRef", "webhookSecretRef"]);
  });
  it("accept the { type: secret_ref, secretId, version? } object the picker stores (host Ajv validator)", () => {
    const config = { enabled: true, githubOrg: "o", webhookSecretRef: binding, githubTokenSecretRef: { ...binding, version: 2 } };
    expect(validateInstanceConfig(config, schema)).toEqual({ valid: true });
    // type: "string" would make the host refuse the stored binding object ("must be string").
    expect(validateInstanceConfig({ webhookSecretRef: "not-a-ref" }, schema).valid).toBe(false);
  });
});

describe("prUrlPatterns", () => {
  it("matches the exact PR and never a longer number", () => {
    const { regex } = prUrlPatterns("togetherweown/two-web-next", 108);
    const re = new RegExp(regex, "i");
    expect(re.test("see https://github.com/TogetherWeOwn/two-web-next/pull/108 now")).toBe(true);
    expect(re.test("https://github.com/TogetherWeOwn/two-web-next/pull/108")).toBe(true);
    expect(re.test("https://github.com/TogetherWeOwn/two-web-next/pull/1081")).toBe(false);
    expect(re.test("https://github.com/TogetherWeOwn/two-webXnext/pull/108")).toBe(false);
  });
});
