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
  SETTLED_OUTCOMES,
  touchSql,
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
    expect(markWakeAttemptedSql(DB_NAMESPACE)).toMatch(/set wake_attempted_at = \$4::timestamptz, issue_id = \$3, updated_at = now\(\)\s+where company_id = \$1 and fingerprint = \$2 and wake_attempted_at is null and created_at = \$5::timestamptz and attempts = \$6$/);
    expect(releaseWakeAttemptSql(DB_NAMESPACE)).toMatch(/outcome = \$4/);
    expect(releaseWakeAttemptSql(DB_NAMESPACE)).toMatch(/where company_id = \$1 and fingerprint = \$2 and wake_attempted_at = \$3::timestamptz$/);
  });
  it("forgetting a row never touches one whose wake may have reached the host, or one changed since this attempt's claim", () => {
    expect(forgetSql(DB_NAMESPACE)).toMatch(/^delete from \S+\.wake_ledger\s+where company_id = \$1 and fingerprint = \$2 and wake_attempted_at is null and updated_at = \$3::timestamptz$/);
  });
  it("a signal is folded only into an attempt in flight whose wake was not requested, voiding its claim token", () => {
    const sql = touchSql(DB_NAMESPACE);
    expect(sql).toMatch(/set signal = \$3::jsonb, updated_at = updated_at \+ interval '1 microsecond'/);
    expect(sql).toMatch(/where company_id = \$1 and fingerprint = \$2 and wake_attempted_at is null and outcome in \('claimed', 'retrying'\)$/);
  });
  it("the dedupe pre-check returns what a redelivery needs to resume a never-attempted row", () => {
    expect(seenSql(DB_NAMESPACE)).toMatch(/outcome, attempts, created_at::text as created_at, updated_at::text as updated_at, signal::text as signal/);
    expect(seenSql(DB_NAMESPACE)).toMatch(/wake_attempted_at::text as wake_attempted_at/);
  });
  it("a retry re-claims its row with a conditional UPDATE on the selected outcome and updated_at", () => {
    const sql = reclaimSql(DB_NAMESPACE);
    expect(sql).toMatch(/set outcome = 'retrying', attempts = attempts \+ 1, updated_at = \$5::timestamptz/); // the claim token
    expect(sql).toMatch(/where company_id = \$1 and fingerprint = \$2 and outcome = \$3 and updated_at::text = \$4/);
  });
  it("retention compacts aged settled rows into dedupe tombstones, never a pending row, and never deletes them", () => {
    const sql = compactSql(DB_NAMESPACE);
    expect(sql).not.toMatch(/delete/i);
    expect(sql).toMatch(/set signal = '\{\}'::jsonb/);
    expect(sql).toMatch(/updated_at < now\(\) - interval '30 days'/);
    expect(sql).toMatch(/and split_part\(outcome, ':', 1\) in \('woken', 'wake_unconfirmed', 'refused', 'held_status', 'held_blockers', 'ambiguous_card', 'shadow'\)$/);
    for (const pending of ["claimed", "retrying", "error", "no_card", "stale"]) expect(SETTLED_OUTCOMES as readonly string[]).not.toContain(pending);
  });
  it("every write of an attempt is fenced on its claim incarnation (created_at, attempts)", () => {
    expect(claimSql(DB_NAMESPACE)).toMatch(/\(company_id, fingerprint, repo, pull_number, head_sha, state, signal, created_at\)\s+values \(\$1, \$2, \$3, \$4, \$5, \$6, \$7::jsonb, \$8::timestamptz\) on conflict do nothing$/);
    expect(recordOutcomeSql(DB_NAMESPACE)).toMatch(/where company_id = \$1 and fingerprint = \$2 and created_at = \$5::timestamptz and attempts = \$6$/);
    expect(markCommentPostedSql(DB_NAMESPACE)).toMatch(/where company_id = \$1 and fingerprint = \$2 and created_at = \$4::timestamptz and attempts = \$5$/);
    // A signal folded into the attempt (touchSql) changes neither column, so it never stops the attempt.
    expect(touchSql(DB_NAMESPACE)).not.toMatch(/created_at|attempts/);
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
    for (const q of [claimSql(DB_NAMESPACE), reclaimSql(DB_NAMESPACE), recordOutcomeSql(DB_NAMESPACE), markCommentPostedSql(DB_NAMESPACE), markWakeAttemptedSql(DB_NAMESPACE), releaseWakeAttemptSql(DB_NAMESPACE), forgetSql(DB_NAMESPACE), touchSql(DB_NAMESPACE), compactSql(DB_NAMESPACE)]) {
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

  // Both predicates of CARD_BY_COMMENT_SQL (c.body ilike $2 and c.body ~* $3) together, as Postgres applies them.
  const owns = (body: string) => {
    const { like, regex } = prUrlPatterns("togetherweown/two-web-next", 1903);
    const likeRe = new RegExp(`^${like.split("%").map((part) => part.replace(/\\(.)/g, "$1").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]*")}$`, "i");
    return likeRe.test(body) && new RegExp(regex, "i").test(body);
  };
  it("requires a real https://github.com URL: another host or an embedded URL is never ownership evidence", () => {
    expect(owns("PR: https://github.com/TogetherWeOwn/two-web-next/pull/1903")).toBe(true);
    expect(owns("https://github.com/TogetherWeOwn/two-web-next/pull/1903/files")).toBe(true);
    expect(owns("[#1903](https://github.com/TogetherWeOwn/two-web-next/pull/1903)")).toBe(true);
    expect(owns("<https://github.com/TogetherWeOwn/two-web-next/pull/1903>")).toBe(true);
    expect(owns("PR:\nhttps://github.com/TogetherWeOwn/two-web-next/pull/1903.")).toBe(true);
    expect(owns("https://notgithub.com/togetherweown/two-web-next/pull/1903")).toBe(false);
    expect(owns("https://evil.github.com/togetherweown/two-web-next/pull/1903")).toBe(false);
    expect(owns("https://github.com.evil.io/togetherweown/two-web-next/pull/1903")).toBe(false);
    expect(owns("https://evil.io/https://github.com/togetherweown/two-web-next/pull/1903")).toBe(false);
    expect(owns("https://evil.io/?u=https://github.com/togetherweown/two-web-next/pull/1903")).toBe(false);
    expect(owns("xhttps://github.com/togetherweown/two-web-next/pull/1903")).toBe(false);
    expect(owns("github.com/togetherweown/two-web-next/pull/1903")).toBe(false); // no scheme: not a URL
    expect(owns("https://github.com/togetherweown/two-web-next/pull/19034")).toBe(false);
    expect(owns("https://github.com/xtogetherweown/two-web-next/pull/1903")).toBe(false);
  });
});
