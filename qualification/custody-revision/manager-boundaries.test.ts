// Copied into the pinned candidate's server tests by Actions.
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const manifest = {
  id: "paperclip.test-custody-revision", apiVersion: 1, version: "1.0.0",
  displayName: "Custody revision control", description: "Synthetic control", author: "Paperclip",
  categories: ["automation"], capabilities: ["issue.documents.read", "issue.documents.write"], entrypoints: {},
} as const;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;

beforeAll(async () => {
  const support = await getEmbeddedPostgresTestSupport();
  if (!support.supported) throw new Error(`PostgreSQL is required: ${JSON.stringify(support)}`);
  tempDb = await startEmbeddedPostgresTestDatabase("custody-manager-boundaries-");
  db = createDb(tempDb.connectionString);
}, 60_000);
afterAll(async () => { await tempDb?.cleanup(); });

it.each(["wrong-company", "missing-capability"] as const)("observes %s with independent seed and positive control", async (boundary) => {
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const issueId = randomUUID();
  for (const id of [companyId, otherCompanyId]) {
    await db.insert(companies).values({ id, name: "Synthetic company", issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
  }
  await db.insert(issues).values({ id: issueId, companyId, identifier: `T${companyId.replace(/-/g, "").toUpperCase()}-1`, title: "Synthetic issue", status: "todo", priority: "medium" });
  const events = { forPlugin: () => ({ emit: async () => {}, subscribe: () => {}, clear: () => {} }) };
  const services = buildHostServices(db, "synthetic-plugin-record", manifest.id, events as any);
  const writable = createHostClientHandlers({ pluginId: manifest.id, capabilities: [...manifest.capabilities], services });
  const readOnly = createHostClientHandlers({ pluginId: manifest.id, capabilities: ["issue.documents.read"], services });
  const entrypointPath = fileURLToPath(new URL("./custody-manager-worker.mjs", import.meta.url));
  const makeHandle = (hostHandlers: typeof writable) => createPluginWorkerHandle(manifest.id, {
    entrypointPath, manifest: manifest as any, config: {}, instanceInfo: { instanceId: "synthetic", hostVersion: "1.0.0" },
    apiVersion: 1, hostHandlers, autoRestart: false, rpcTimeoutMs: 10_000,
    execArgv: ["--import", import.meta.resolve("tsx")],
  });
  const authorized = makeHandle(writable);
  const restricted = boundary === "missing-capability" ? makeHandle(readOnly) : authorized;
  const write = (handle: typeof authorized, targetCompanyId: string, body: string, baseRevisionId: string | null) => handle.call("getData", {
    key: "write", companyId, params: { targetCompanyId, issueId, documentKey: "plan", body, baseRevisionId },
  } as any);
  const read = () => writable["issues.documents.get"]({ companyId, issueId, key: "plan" }, { invocationScope: { companyId } } as any);
  try {
    await authorized.start();
    if (restricted !== authorized) await restricted.start();
    const seed: any = await write(authorized, companyId, "original", null);
    expect(seed).toMatchObject({ key: "plan", body: "original", latestRevisionNumber: 1 });
    expect(seed.latestRevisionId).toBeTruthy();
    const outcome = await Promise.allSettled([write(restricted, boundary === "wrong-company" ? otherCompanyId : companyId, "denied", seed.latestRevisionId)]);
    const preserved = await read();
    console.info("manager-boundary", JSON.stringify({ boundary, outcome: outcome[0].status === "rejected" ? { status: "rejected", error: String(outcome[0].reason), code: outcome[0].reason?.code } : { status: "fulfilled", value: outcome[0].value }, preserved }));
    expect(outcome[0].status).toBe("rejected");
    expect(preserved).toMatchObject({ key: "plan", body: "original", latestRevisionId: seed.latestRevisionId, latestRevisionNumber: 1 });
    const positive: any = await write(authorized, companyId, "authorized", seed.latestRevisionId);
    const saved = await read();
    expect(saved).toMatchObject({ key: "plan", body: "authorized", latestRevisionId: positive.latestRevisionId, latestRevisionNumber: 2 });
    expect(positive.latestRevisionId).not.toBe(seed.latestRevisionId);
    console.info("manager-positive-control", JSON.stringify({ boundary, saved }));
  } finally {
    try {
      if (restricted !== authorized) await restricted.stop();
    } finally {
      try { await authorized.stop(); } finally { services.dispose(); }
    }
  }
}, 90_000);
