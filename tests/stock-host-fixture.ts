import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import ts from "typescript";

const run = promisify(execFile);

/** Disposable Actions-only fixture; it is not the host parameter binder. */
export function stockHostFixture() {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted"
      || process.env.RELEASE_TEST_DATABASE !== "postgresql://postgres:fixture@localhost:5432/fixture"
      || !process.env.HOST_SQL_SOURCE) throw new Error("disposable hosted fixture required");
  const source = readFileSync(process.env.HOST_SQL_SOURCE, "utf8");
  const start = source.indexOf("const IDENTIFIER_RE =");
  const end = source.indexOf("function bindSql(");
  if (start < 0 || end <= start) throw new Error("pinned host source layout changed");
  const js = ts.transpileModule(`${source.slice(start, end)}\nexport { splitSqlStatements };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText;
  const host: Record<string, (...args: any[]) => any> = {};
  new Function("exports", "createHash", js)(host, createHash);
  const namespace: string = host.derivePluginDatabaseNamespace!("togetherweown.pr-doer-wake", "pr_custody");
  const psql = async (sql: string) => (await run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    env: { PATH: process.env.PATH, PGHOST: "localhost", PGPORT: "5432", PGUSER: "postgres", PGPASSWORD: "fixture", PGDATABASE: "fixture" },
  })).stdout;
  return {
    namespace,
    async migrate(sql: string) {
      const statements: string[] = host.splitSqlStatements!(sql);
      if (statements.length === 0) throw new Error("empty fixture migration");
      await psql(`CREATE SCHEMA IF NOT EXISTS ${namespace}`);
      for (const statement of statements) {
        host.validatePluginMigrationStatement!(statement, namespace, []);
        await psql(statement);
      }
    },
    async execute(sql: string, params: unknown[] = []) {
      host.validatePluginRuntimeExecute!(sql, namespace);
      // Deliberately limited to synthetic strings and integers, not a production binder.
      const seen = new Set<number>();
      const bound = sql.replace(/\$(\d+)/g, (_, n: string) => {
        seen.add(Number(n));
        const value = params[Number(n) - 1];
        if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value))) throw new Error("unsupported fixture parameter");
        return `'${String(value).replaceAll("'", "''")}'`;
      });
      if (params.length && seen.size !== params.length) throw new Error("Every ctx.db parameter must be referenced by a $n placeholder");
      const output = await psql(bound);
      const count = /(?:INSERT 0|UPDATE|DELETE) (\d+)/.exec(output);
      if (!count) throw new Error(`missing command count: ${output}`);
      return { rowCount: Number(count[1]) };
    },
  };
}
