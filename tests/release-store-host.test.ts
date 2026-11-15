import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ReleaseStore, type NamespaceDatabase } from "../src/release-store.js";

const namespace = "plugin_pr_custody_2a97cdbae1";
const company = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const identity = { confirmationId: "cccccccc-cccc-cccc-cccc-cccccccccccc", repo: "example/repo", sha: "a".repeat(40), stagingRunId: "123", stagingRunAttempt: 1, expiresAt: "" };
const enabled = process.env.HOST_SQL_SOURCE && process.env.RELEASE_TEST_DATABASE;

describe.skipIf(!enabled)("stock validator and PostgreSQL lifecycle", () => {
  it("validates migration and statements and serializes independent workers", async () => {
    if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") throw new Error("synthetic hosted runner only");
    const source = readFileSync(process.env.HOST_SQL_SOURCE!, "utf8");
    const start = source.indexOf("const IDENTIFIER_RE =");
    const end = source.indexOf("function bindSql(");
    if (start < 0 || end <= start) throw new Error("pinned host source layout changed");
    const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText;
    const exports: Record<string, (...args: any[]) => any> = {};
    new Function("exports", "createHash", js)(exports, createHash);
    expect(exports.derivePluginDatabaseNamespace!("togetherweown.pr-doer-wake", "pr_custody")).toBe(namespace);
    const run = promisify(execFile);
    const psql = async (sql: string) => (await run("psql", [process.env.RELEASE_TEST_DATABASE!, "-X", "-v", "ON_ERROR_STOP=1", "-c", sql])).stdout;
    const migration = readFileSync("custody-migrations/001_release_lifecycle.sql", "utf8");
    exports.validatePluginMigrationStatement!(migration, namespace, []);
    await psql(`CREATE SCHEMA ${namespace}`);
    await psql(migration);
    const execute = async (sql: string, params: unknown[] = []) => {
      exports.validatePluginRuntimeExecute!(sql, namespace);
      // Synthetic fixture parameters only; production binding is the host's parameter binder.
      const bound = sql.replace(/\$(\d+)/g, (_, n: string) => `'${String(params[Number(n) - 1]).replaceAll("'", "''")}'`);
      const output = await psql(bound);
      const count = /(?:INSERT 0|UPDATE) (\d+)/.exec(output);
      if (!count) throw new Error(`missing command count: ${output}`);
      return { rowCount: Number(count[1]) };
    };
    const db: NamespaceDatabase = { namespace, execute };
    const target = { ...identity, expiresAt: new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z") };
    expect(await new ReleaseStore(db).create(company, target)).toBe("applied");
    expect(await new ReleaseStore(db).create(company, { ...target, sha: "b".repeat(40) })).toBe("unknown");
    const ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];
    const results = await Promise.all(ids.map((id) => new ReleaseStore(db).claim(company, target, id)));
    expect(results.filter((r) => r === "applied")).toHaveLength(1);
    const winner = ids[results.indexOf("applied")]!;
    expect(await new ReleaseStore(db).consume(company, { ...target, sha: "b".repeat(40) }, winner)).toBe("unknown");
    expect(await new ReleaseStore(db).consume(company, target, winner)).toBe("applied");
    expect(await new ReleaseStore(db).revoke(company, target)).toBe("unknown");
    expect(await new ReleaseStore(db).claim(company, target, winner)).toBe("unknown");
    const second = { ...target, confirmationId: "dddddddd-dddd-dddd-dddd-dddddddddddd" };
    expect(await new ReleaseStore(db).create(company, second)).toBe("applied");
    expect(await new ReleaseStore(db).claim("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", second, winner)).toBe("unknown");
    expect(await new ReleaseStore(db).claim(company, second, winner)).toBe("applied");
    const race = await Promise.all([new ReleaseStore(db).consume(company, second, winner), new ReleaseStore(db).revoke(company, second)]);
    expect(race.filter((r) => r === "applied")).toHaveLength(1);
    expect(await new ReleaseStore(db).claim(company, second, winner)).toBe("unknown");
    const past = { ...target, confirmationId: "ffffffff-ffff-ffff-ffff-ffffffffffff", expiresAt: "2020-01-01T00:00:00Z" };
    expect(await new ReleaseStore(db).create(company, past)).toBe("unknown");
  });
});
