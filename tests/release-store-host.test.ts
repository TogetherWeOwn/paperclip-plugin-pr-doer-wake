import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ReleaseStore } from "../src/release-store.js";
import { stockHostFixture } from "./stock-host-fixture.js";

const company = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const otherCompany = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const claim = "11111111-1111-1111-1111-111111111111";
const identity = { confirmationId: "cccccccc-cccc-cccc-cccc-cccccccccccc", repo: "example/repo", sha: "a".repeat(40), stagingRunId: "123", stagingRunAttempt: 1, expiresAt: "" };
const enabled = process.env.HOST_SQL_SOURCE || process.env.RELEASE_TEST_DATABASE;

describe.skipIf(!enabled)("stock validator and PostgreSQL lifecycle", () => {
  it("validates transitions and leaves disabled operations unchanged", async () => {
    // The fixture checks the hosted runner and exact disposable database before any SQL.
    const db = stockHostFixture();
    const table = `${db.namespace}.release_lifecycle`;
    await db.migrate(readFileSync("custody-migrations/001_release_lifecycle.sql", "utf8"));
    const store = new ReleaseStore(db);
    const target = { ...identity, expiresAt: new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z") };
    const run = promisify(execFile);
    const snapshot = async () => (await run("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", `SELECT row_to_json(t)::text FROM ${table} t ORDER BY company_id, confirmation_id`], {
      env: { PATH: process.env.PATH, PGHOST: "localhost", PGPORT: "5432", PGUSER: "postgres", PGPASSWORD: "fixture", PGDATABASE: "fixture", PGOPTIONS: "-c standard_conforming_strings=on" },
    })).stdout;

    expect(await store.create(company, target)).toBe("applied");
    const countSql = `UPDATE ${table} SET state = $1 WHERE company_id = $2::uuid AND confirmation_id = $3::uuid`;
    expect(await db.execute(countSql, ["available", company, target.confirmationId])).toEqual({ rowCount: 1 });
    expect(await db.execute(countSql, ["available", otherCompany, target.confirmationId])).toEqual({ rowCount: 0 });
    expect(await store.create(company, { ...target, sha: "b".repeat(40) })).toBe("unknown");
    expect(await store.create(otherCompany, target)).toBe("applied");
    expect(await store.revoke(otherCompany, { ...target, sha: "b".repeat(40) })).toBe("unknown");
    const available = await snapshot();
    expect(await store.claim(company, target, claim)).toBe("unknown");
    expect(await store.consume(company, target, claim)).toBe("unknown");
    expect(await snapshot()).toBe(available);

    // Seed a claimed row through the validated synthetic fixture only.
    expect(await db.execute(`UPDATE ${table} SET state = $1, claim_id = $2::uuid WHERE company_id = $3::uuid AND confirmation_id = $4::uuid`, ["claimed", claim, company, target.confirmationId])).toEqual({ rowCount: 1 });
    const claimed = await snapshot();
    expect(claimed).not.toBe(available);
    expect(await store.claim(company, target, claim)).toBe("unknown");
    expect(await store.consume(company, target, claim)).toBe("unknown");
    expect(await snapshot()).toBe(claimed);

    const race = await Promise.all([store.revoke(company, target), store.revoke(company, target)]);
    expect(race.filter((result) => result === "applied")).toHaveLength(1);
    expect(race.filter((result) => result === "unknown")).toHaveLength(1);
    expect(await store.revoke(company, target)).toBe("unknown");
    expect(await store.revoke(otherCompany, target)).toBe("applied");
    const past = { ...target, confirmationId: "ffffffff-ffff-ffff-ffff-ffffffffffff", expiresAt: "2020-01-01T00:00:00Z" };
    expect(await store.create(company, past)).toBe("unknown");
  });
});
