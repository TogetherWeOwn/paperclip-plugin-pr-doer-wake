import { describe, expect, it } from "vitest";
import { stockHostFixture } from "./stock-host-fixture.js";

// The dedicated Actions job supplies both variables; ordinary unit runs do not.
describe.skipIf(!process.env.HOST_SQL_SOURCE && !process.env.RELEASE_TEST_DATABASE)("stock host SQL fixture", () => {
  it("validates and executes synthetic namespace SQL", async () => {
    const db = stockHostFixture();
    expect(db.namespace).toBe("plugin_pr_custody_2a97cdbae1");
    const table = `${db.namespace}.fixture_rows`;
    await db.migrate(`CREATE TABLE ${table} (id text PRIMARY KEY, value text NOT NULL);`);
    expect(await db.execute(`INSERT INTO ${table} (id, value) VALUES ($1, $2)`, ["one", "it's synthetic"])).toEqual({ rowCount: 1 });
    expect(await db.execute(`UPDATE ${table} SET value = $1 WHERE id = $2`, ["changed", "missing"])).toEqual({ rowCount: 0 });
    await db.migrate(`CREATE TABLE ${db.namespace}.second_rows (id text PRIMARY KEY);`);
    await expect(db.migrate(`CREATE TABLE ${db.namespace}.third_rows (id text); DROP TABLE ${table};`))
      .rejects.toThrow("Destructive plugin migrations are not allowed");
    await expect(db.execute(`UPDATE ${table} SET value = $1`, ["changed", "unused"]))
      .rejects.toThrow("Every ctx.db parameter must be referenced");
    await expect(db.execute("UPDATE public.fixture_rows SET value = 'wrong' WHERE id = 'one'"))
      .rejects.toThrow("ctx.db.execute target must be inside plugin namespace");
  });
});
