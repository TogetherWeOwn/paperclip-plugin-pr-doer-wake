import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import manifest from "../src/manifest.js";
import { DB_NAMESPACE, NAMESPACE_SLUG, PLUGIN_ID } from "../src/constants.js";
import {
  CARD_BY_COMMENT_SQL,
  CARD_BY_IDENTIFIER_SQL,
  claimSql,
  prUrlPatterns,
  pruneSql,
  recordOutcomeSql,
  retryableSql,
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
  it("migration passes the host migration validator", () => {
    const sql = readFileSync(new URL("../migrations/001_wake_ledger.sql", import.meta.url), "utf8");
    const statements = splitSqlStatements(sql);
    expect(statements.length).toBe(2);
    for (const s of statements) expect(() => validatePluginMigrationStatement(s, DB_NAMESPACE, core)).not.toThrow();
  });
  it("runtime queries pass validatePluginRuntimeQuery with only issues + issue_comments", () => {
    for (const q of [CARD_BY_IDENTIFIER_SQL, CARD_BY_COMMENT_SQL, retryableSql(DB_NAMESPACE)]) {
      expect(() => validatePluginRuntimeQuery(q, DB_NAMESPACE, core)).not.toThrow();
    }
    expect(() => validatePluginRuntimeQuery(CARD_BY_COMMENT_SQL, DB_NAMESPACE, ["issues"])).toThrow(/issue_comments/);
  });
  it("runtime writes pass validatePluginRuntimeExecute", () => {
    for (const q of [claimSql(DB_NAMESPACE), recordOutcomeSql(DB_NAMESPACE), pruneSql(DB_NAMESPACE)]) {
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
