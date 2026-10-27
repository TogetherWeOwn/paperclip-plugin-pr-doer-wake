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
  it("retries failed rows, rows stuck at claimed or retrying and card-pending rows with a growing backoff", () => {
    const sql = retryableSql(DB_NAMESPACE);
    expect(sql).toMatch(/outcome = 'error'/);
    expect(sql).toMatch(/outcome in \('claimed', 'retrying'\) and updated_at < now\(\) - interval '10 minutes'/);
    expect(sql).toMatch(/outcome = 'no_card' and updated_at < now\(\) - interval '5 minutes' \* \(attempts \+ 1\)/);
    expect(sql).toMatch(/attempts < 4/);
    expect(sql).toMatch(/signal <> '\{\}'::jsonb/); // compacted tombstones are never retried
    expect(sql).toMatch(/updated_at::text as updated_at/);
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
  });
  it("runtime writes pass validatePluginRuntimeExecute", () => {
    for (const q of [claimSql(DB_NAMESPACE), reclaimSql(DB_NAMESPACE), recordOutcomeSql(DB_NAMESPACE), markCommentPostedSql(DB_NAMESPACE), markWakeAttemptedSql(DB_NAMESPACE), releaseWakeAttemptSql(DB_NAMESPACE), compactSql(DB_NAMESPACE)]) {
      expect(() => validatePluginRuntimeExecute(q, DB_NAMESPACE)).not.toThrow();
    }
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
