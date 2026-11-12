// Copied into server/src/__tests__ in the pinned upstream checkout by Actions.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { definePlugin } from "../../../packages/plugins/sdk/src/define-plugin.js";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import { startWorkerRpcHost } from "../../../packages/plugins/sdk/src/worker-rpc-host.js";
import { createErrorResponse, createRequest, createSuccessResponse, isJsonRpcRequest, isJsonRpcResponse, parseMessage, serializeMessage } from "../../../packages/plugins/sdk/src/protocol.js";

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
  tempDb = await startEmbeddedPostgresTestDatabase("custody-revision-control-");
  db = createDb(tempDb.connectionString);
}, 60_000);

afterAll(async () => { await tempDb?.cleanup(); });

it("observes the pinned worker-to-host sequential revision contract", async () => {
  const companyId = randomUUID();
  const issueId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Synthetic company", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
  await db.insert(issues).values({ id: issueId, companyId, identifier: "TEST-1", title: "Synthetic issue", status: "todo", priority: "medium" });
  const events = { forPlugin: () => ({ emit: async () => {}, subscribe: () => {}, clear: () => {} }) };
  const services = buildHostServices(db, "synthetic-plugin-record", manifest.id, events as any);
  const handlers = createHostClientHandlers({ pluginId: manifest.id, capabilities: [...manifest.capabilities], services });
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = createInterface({ input: output });
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const forwarded: any[] = [];
  let nextId = 0;
  const plugin = definePlugin({ async setup(ctx) {
    ctx.data.register("write", async (params) => ctx.issues.documents.upsert({
      companyId, issueId, key: "plan", body: params.body as string, baseRevisionId: params.baseRevisionId as string | null,
    }));
  } });
  const worker = startWorkerRpcHost({ plugin, stdin: input, stdout: output });
  const call = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = `control-${++nextId}`;
    pending.set(id, { resolve, reject });
    input.write(serializeMessage(createRequest(method, params, id)));
  });
  lines.on("line", (line) => {
    const message = parseMessage(line);
    if (isJsonRpcResponse(message)) {
      const request = pending.get(String(message.id));
      pending.delete(String(message.id));
      if ("error" in message && message.error) request?.reject(new Error(message.error.message));
      else request?.resolve((message as any).result);
      return;
    }
    if (!isJsonRpcRequest(message)) return;
    if (message.method !== "issues.documents.upsert") {
      input.write(serializeMessage(createErrorResponse(message.id, -32601, "Unexpected host method")));
      return;
    }
    forwarded.push(message.params);
    Promise.resolve().then(() => handlers["issues.documents.upsert"](message.params as any, { invocationScope: { companyId } } as any))
      .then((result) => input.write(serializeMessage(createSuccessResponse(message.id, result))))
      .catch((error) => input.write(serializeMessage(createErrorResponse(message.id, -32000, String(error.message)))));
  });
  try {
    await call("initialize", { manifest, config: {}, databaseNamespace: null });
    const created = await call("getData", { key: "write", companyId, params: { body: "v1", baseRevisionId: null } });
    expect(created).toMatchObject({ key: "plan", body: "v1", latestRevisionNumber: 1 });
    expect(created.latestRevisionId).toBeTruthy();
    const params = { key: "write", companyId, params: { body: "v2", baseRevisionId: created.latestRevisionId } };
    let updatedRevisionId: string | undefined;
    if (process.env.CUSTODY_EXPECTATION === "baseline") {
      await expect(call("getData", params)).rejects.toThrow("Document update requires baseRevisionId");
      expect(forwarded[1]).not.toHaveProperty("baseRevisionId");
    } else if (process.env.CUSTODY_EXPECTATION === "candidate") {
      const updated = await call("getData", params);
      expect(forwarded[1].baseRevisionId).toBe(created.latestRevisionId);
      expect(updated).toMatchObject({ key: "plan", body: "v2", latestRevisionNumber: 2 });
      expect(updated.latestRevisionId).toBeTruthy();
      expect(updated.latestRevisionId).not.toBe(created.latestRevisionId);
      updatedRevisionId = updated.latestRevisionId;
    } else {
      throw new Error("CUSTODY_EXPECTATION must identify the pinned baseline or candidate");
    }
    const saved = await handlers["issues.documents.get"]({ companyId, issueId, key: "plan" }, { invocationScope: { companyId } } as any);
    expect(saved).toMatchObject({ key: "plan", body: process.env.CUSTODY_EXPECTATION === "candidate" ? "v2" : "v1", latestRevisionNumber: process.env.CUSTODY_EXPECTATION === "candidate" ? 2 : 1 });
    if (process.env.CUSTODY_EXPECTATION === "candidate") expect(saved?.latestRevisionId).toBe(updatedRevisionId);
    console.info("sequential-control", JSON.stringify({ expectation: process.env.CUSTODY_EXPECTATION, created: { key: created.key, body: created.body, revision: created.latestRevisionId }, saved: { key: saved?.key, body: saved?.body, revision: saved?.latestRevisionId }, forwardedRevision: forwarded[1]?.baseRevisionId ?? null }));
  } finally {
    worker.stop();
    lines.close();
    input.destroy();
    output.destroy();
    services.dispose();
  }
}, 60_000);
