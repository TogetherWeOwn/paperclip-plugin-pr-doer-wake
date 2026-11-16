// Copied into the pinned stock host's server tests by Actions.
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { companies, createDb, pluginMigrations, pluginState, plugins } from "@paperclipai/db";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { pluginDatabaseService } from "../services/plugin-database.js";
import { createPluginWorkerManager } from "../services/plugin-worker-manager.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;

beforeAll(async () => {
  const support = await getEmbeddedPostgresTestSupport();
  if (!support.supported) throw new Error(`PostgreSQL is required: ${JSON.stringify(support)}`);
  tempDb = await startEmbeddedPostgresTestDatabase("rollback-lifecycle-");
  db = createDb(tempDb.connectionString);
}, 60_000);
afterAll(async () => { await tempDb?.cleanup(); });

it("preserves migration and instance state across installed, previous, and restored workers", async () => {
  const installed = process.env.INSTALLED_PACKAGE_ROOT;
  const previous = process.env.PREVIOUS_PACKAGE_ROOT;
  if (!installed || !previous) throw new Error("Both verified package roots are required");
  const roots = [installed, previous, previous, installed];
  const manifests = await Promise.all(roots.map(async (root) => (await import(pathToFileURL(join(root, "dist/manifest.js")).href)).default));
  const pluginId = randomUUID();
  const companyId = randomUUID();
  const runContext = { companyId, agentId: randomUUID(), runId: randomUUID(), projectId: randomUUID() };
  expect(manifests.map((m) => m.id)).toEqual(Array(3).fill("togetherweown.pr-doer-wake"));
  await db.insert(companies).values({ id: companyId, name: "Synthetic company", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
  await db.insert(plugins).values({ id: pluginId, pluginKey: manifests[0].id, packageName: "@togetherweown/paperclip-plugin-pr-doer-wake", version: manifests[0].version, apiVersion: 1, manifestJson: manifests[0] });
  const events = { forPlugin: () => ({ emit: async () => {}, subscribe: () => {}, clear: () => {} }) };
  const services = buildHostServices(db, pluginId, manifests[0].id, events as any);
  const database = pluginDatabaseService(db);
  const manager = createPluginWorkerManager();
  let previousLedger: unknown[] | undefined;
  let previousState: any;
  try {
    for (const [index, root] of roots.entries()) {
      const manifest = manifests[index];
      const namespace = await database.applyMigrations(pluginId, manifest, root);
      expect(namespace?.namespaceName).toBe("plugin_pr_custody_2a97cdbae1");
      const ledger = await db.select().from(pluginMigrations).where(eq(pluginMigrations.pluginId, pluginId));
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ migrationKey: "001_release_lifecycle.sql", status: "applied", namespaceName: namespace!.namespaceName });
      if (previousLedger) expect(ledger).toEqual(previousLedger);
      previousLedger = ledger;
      const stateBefore = await db.select().from(pluginState).where(eq(pluginState.pluginId, pluginId));
      if (previousState) expect(stateBefore).toEqual(previousState);
      const handlers = createHostClientHandlers({ pluginId: manifest.id, capabilities: [...manifest.capabilities], services });
      // Never let a fixture mistake send traffic or dispatch a real wake.
      handlers["http.fetch"] = async () => { throw new Error("unexpected external HTTP request"); };
      handlers["issues.requestWakeup"] = async () => { throw new Error("unexpected wake request"); };
      handlers["issues.requestWakeups"] = async () => { throw new Error("unexpected wake requests"); };
      const handle = await manager.startWorker(manifest.id, {
        entrypointPath: join(root, "dist/worker.js"), manifest, config: {}, databaseNamespace: namespace!.namespaceName,
        instanceInfo: { instanceId: "rollback-fixture", hostVersion: "2026.1106.0" }, apiVersion: 1,
        hostHandlers: handlers, autoRestart: false, rpcTimeoutMs: 10_000,
      });
      try {
        const started = handle.diagnostics();
        expect(started.status).toBe("running");
        expect(started.pid).not.toBeNull();
        await manager.call(manifest.id, "configChanged", { companyId, config: {} });
        await manager.call(manifest.id, "runJob", { job: { jobKey: "ci-wake-poll", runId: randomUUID(), trigger: "manual", scheduledAt: new Date().toISOString() } });
        const result = await manager.call(manifest.id, "executeTool", { toolName: "ci_wait_register", parameters: {}, runContext });
        expect(result.data).toMatchObject({ code: "invalid_registration" });
        previousState = await db.select().from(pluginState).where(eq(pluginState.pluginId, pluginId));
        expect(previousState.length).toBeGreaterThan(0);
        console.info("rollback-start", JSON.stringify({ phase: index, pluginId, namespace: namespace!.namespaceName, pid: started.pid, ledger: ledger.map(({ migrationKey, checksum, status }) => ({ migrationKey, checksum, status })), stateRows: previousState.length }));
      } finally {
        await manager.stopWorker(manifest.id);
        const stopped = handle.diagnostics();
        console.info("rollback-stop", JSON.stringify({ phase: index, status: stopped.status, pid: stopped.pid, pendingRequests: stopped.pendingRequests }));
        expect(stopped).toMatchObject({ status: "stopped", pid: null, pendingRequests: 0 });
      }
    }
    const result = await db.execute(sql`select count(*)::int as count from plugin_pr_custody_2a97cdbae1.release_lifecycle`);
    expect(Array.from(result)[0]).toMatchObject({ count: 0 });
  } finally {
    await manager.stopAll();
    services.dispose();
  }
}, 180_000);
