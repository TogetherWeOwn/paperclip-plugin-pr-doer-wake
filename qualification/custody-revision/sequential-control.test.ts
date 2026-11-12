// Copied into server/src/__tests__ in the pinned upstream checkout by Actions.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { documentService } from "../services/documents.js";
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
  const readOnlyHandlers = createHostClientHandlers({ pluginId: manifest.id, capabilities: ["issue.documents.read"], services });
  let denyWriteCapability = false;
  let dropNextWriteReply = false;
  let notifyDroppedReply: (() => void) | undefined;
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = createInterface({ input: output });
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const forwarded: any[] = [];
  // This is an incomplete sequential evidence tranche, not isolated tests: later
  // cases depend on earlier winners and do not run after an assertion fails.
  // A started case is not necessarily complete or passing. Abrupt termination
  // can prevent the reachability ledger in finally from being emitted.
  const candidateCases = ["invalid-base-writes", "plugin-race", "first-create-race", "authorization-boundaries", "independent-writer-race", "dropped-reply-readback"] as const;
  const startedCases = new Set<string>();
  let raceArrivals = 0;
  let releaseRace: (() => void) | undefined;
  let raceGate: Promise<void> | undefined;
  let nextId = 0;
  const plugin = definePlugin({ async setup(ctx) {
    ctx.data.register("write", async (params) => ctx.issues.documents.upsert({
      companyId: (params.targetCompanyId as string | undefined) ?? companyId, issueId, key: (params.documentKey as string | undefined) ?? "plan", body: params.body as string, baseRevisionId: params.baseRevisionId as string | null,
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
    Promise.resolve().then(async () => {
      if (raceGate) {
        if (++raceArrivals === 2) releaseRace?.();
        await raceGate;
      }
      return (denyWriteCapability ? readOnlyHandlers : handlers)["issues.documents.upsert"](message.params as any, { invocationScope: { companyId } } as any);
    })
      .then((result) => {
        if (dropNextWriteReply) {
          dropNextWriteReply = false;
          notifyDroppedReply?.();
          return;
        }
        input.write(serializeMessage(createSuccessResponse(message.id, result)));
      })
      .catch((error) => input.write(serializeMessage(createErrorResponse(message.id, -32000, String(error.message)))));
  });
  try {
    await call("initialize", { manifest, config: {}, databaseNamespace: null });
    const created = await call("getData", { key: "write", companyId, params: { body: "v1", baseRevisionId: null } });
    expect(created).toMatchObject({ key: "plan", body: "v1", latestRevisionNumber: 1 });
    expect(created.latestRevisionId).toBeTruthy();
    const params = { key: "write", companyId, params: { body: "v2", baseRevisionId: created.latestRevisionId } };
    if (process.env.CUSTODY_EXPECTATION === "baseline") {
      await expect(call("getData", params)).rejects.toThrow("Document update requires baseRevisionId");
      expect(forwarded[1]).not.toHaveProperty("baseRevisionId");
    } else if (process.env.CUSTODY_EXPECTATION === "candidate") {
      const updated = await call("getData", params);
      expect(forwarded[1].baseRevisionId).toBe(created.latestRevisionId);
      expect(updated).toMatchObject({ key: "plan", body: "v2", latestRevisionNumber: 2 });
      expect(updated.latestRevisionId).not.toBe(created.latestRevisionId);
    } else {
      throw new Error("CUSTODY_EXPECTATION must identify the pinned baseline or candidate");
    }
    const saved = await handlers["issues.documents.get"]({ companyId, issueId, key: "plan" }, { invocationScope: { companyId } } as any);
    expect(saved).toMatchObject({ key: "plan", body: process.env.CUSTODY_EXPECTATION === "candidate" ? "v2" : "v1", latestRevisionNumber: process.env.CUSTODY_EXPECTATION === "candidate" ? 2 : 1 });
    console.info("sequential-control", JSON.stringify({ expectation: process.env.CUSTODY_EXPECTATION, created: { key: created.key, body: created.body, revision: created.latestRevisionId }, saved: { key: saved?.key, body: saved?.body, revision: saved?.latestRevisionId }, forwardedRevision: forwarded[1]?.baseRevisionId ?? null }));
    if (process.env.CUSTODY_EXPECTATION === "candidate") {
      startedCases.add("invalid-base-writes");
      const rejectedWrites = [];
      for (const [label, baseRevisionId] of [["stale", created.latestRevisionId], ["blind", null], ["nonexistent", randomUUID()]] as const) {
        const outcome = await Promise.allSettled([call("getData", { key: "write", companyId, params: { body: label, baseRevisionId } })]);
        const readback = await handlers["issues.documents.get"]({ companyId, issueId, key: "plan" }, { invocationScope: { companyId } } as any);
        rejectedWrites.push({ label, status: outcome[0].status, outcome: outcome[0].status === "rejected" ? String(outcome[0].reason) : outcome[0].value, readback });
      }
      console.info("invalid-base-writes", JSON.stringify(rejectedWrites));
      for (const entry of rejectedWrites) {
        expect(entry.status).toBe("rejected");
        expect(entry.readback).toMatchObject({ key: "plan", body: "v2", latestRevisionId: saved!.latestRevisionId, latestRevisionNumber: 2 });
      }
      startedCases.add("plugin-race");
      const raceForwardedStart = forwarded.length;
      let raceTimer: ReturnType<typeof setTimeout> | undefined;
      raceGate = new Promise<void>((resolve, reject) => {
        releaseRace = () => { clearTimeout(raceTimer); resolve(); };
        raceTimer = setTimeout(() => reject(new Error(`Race rendezvous timed out after ${raceArrivals} arrivals`)), 5_000);
      });
      const writers = ["race-a", "race-b"].map((body) => call("getData", {
        key: "write", companyId, params: { body, baseRevisionId: saved!.latestRevisionId },
      }));
      const outcomes = await Promise.allSettled(writers);
      const afterRace = await handlers["issues.documents.get"]({ companyId, issueId, key: "plan" }, { invocationScope: { companyId } } as any);
      console.info("plugin-race", JSON.stringify({ baseRevision: saved!.latestRevisionId, forwarded: forwarded.slice(raceForwardedStart), outcomes: outcomes.map((outcome) => outcome.status === "fulfilled" ? { status: outcome.status, body: outcome.value.body, revision: outcome.value.latestRevisionId } : { status: outcome.status, error: String(outcome.reason) }), saved: { body: afterRace?.body, revision: afterRace?.latestRevisionId } }));
      expect(raceArrivals).toBe(2);
      expect(forwarded.slice(raceForwardedStart).map((entry) => entry.baseRevisionId)).toEqual([saved!.latestRevisionId, saved!.latestRevisionId]);
      const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const losers = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      const winner = (winners[0] as PromiseFulfilledResult<any>).value;
      expect(["race-a", "race-b"]).toContain(winner.body);
      expect(afterRace).toMatchObject({ key: "plan", body: winner.body, latestRevisionId: winner.latestRevisionId, latestRevisionNumber: 3 });
      expect(winner.latestRevisionId).not.toBe(saved!.latestRevisionId);

      raceArrivals = 0;
      startedCases.add("first-create-race");
      const createForwardedStart = forwarded.length;
      raceGate = new Promise<void>((resolve, reject) => {
        releaseRace = () => { clearTimeout(raceTimer); resolve(); };
        raceTimer = setTimeout(() => reject(new Error(`Create rendezvous timed out after ${raceArrivals} arrivals`)), 5_000);
      });
      const creates = ["create-a", "create-b"].map((body) => call("getData", {
        key: "write", companyId, params: { documentKey: "new-plan", body, baseRevisionId: null },
      }));
      const createOutcomes = await Promise.allSettled(creates);
      const afterCreate = await handlers["issues.documents.get"]({ companyId, issueId, key: "new-plan" }, { invocationScope: { companyId } } as any);
      const preserved = await handlers["issues.documents.get"]({ companyId, issueId, key: "plan" }, { invocationScope: { companyId } } as any);
      console.info("first-create-race", JSON.stringify({ forwarded: forwarded.slice(createForwardedStart), outcomes: createOutcomes.map((outcome) => outcome.status === "fulfilled" ? { status: outcome.status, body: outcome.value.body, revision: outcome.value.latestRevisionId } : { status: outcome.status, error: String(outcome.reason) }), saved: afterCreate, preserved }));
      expect(raceArrivals).toBe(2);
      expect(forwarded.slice(createForwardedStart)).toHaveLength(2);
      const createWinners = createOutcomes.filter((outcome) => outcome.status === "fulfilled");
      expect(createWinners).toHaveLength(1);
      expect(createOutcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      const createWinner = (createWinners[0] as PromiseFulfilledResult<any>).value;
      expect(["create-a", "create-b"]).toContain(createWinner.body);
      expect(afterCreate).toMatchObject({ key: "new-plan", body: createWinner.body, latestRevisionId: createWinner.latestRevisionId, latestRevisionNumber: 1 });
      expect(preserved).toMatchObject({ key: "plan", body: winner.body, latestRevisionId: winner.latestRevisionId, latestRevisionNumber: 3 });

      raceGate = undefined;
      startedCases.add("authorization-boundaries");
      const otherCompanyId = randomUUID();
      await db.insert(companies).values({ id: otherCompanyId, name: "Other synthetic company", issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
      const boundaryOutcomes = [];
      for (const boundary of ["wrong-company", "missing-capability"] as const) {
        denyWriteCapability = boundary === "missing-capability";
        const outcome = await Promise.allSettled([call("getData", { key: "write", companyId, params: {
          body: boundary, baseRevisionId: winner.latestRevisionId,
          ...(boundary === "wrong-company" ? { targetCompanyId: otherCompanyId } : {}),
        } })]);
        denyWriteCapability = false;
        const readback = await handlers["issues.documents.get"]({ companyId, issueId, key: "plan" }, { invocationScope: { companyId } } as any);
        boundaryOutcomes.push({ boundary, status: outcome[0].status, outcome: outcome[0].status === "rejected" ? String(outcome[0].reason) : outcome[0].value, readback });
      }
      console.info("authorization-boundaries", JSON.stringify(boundaryOutcomes));
      for (const entry of boundaryOutcomes) {
        expect(entry.status).toBe("rejected");
        expect(entry.readback).toMatchObject({ key: "plan", body: winner.body, latestRevisionId: winner.latestRevisionId, latestRevisionNumber: 3 });
      }
      const positive = await call("getData", { key: "write", companyId, params: { body: "authorized", baseRevisionId: winner.latestRevisionId } });
      const positiveReadback = await handlers["issues.documents.get"]({ companyId, issueId, key: "plan" }, { invocationScope: { companyId } } as any);
      expect(positiveReadback).toMatchObject({ key: "plan", body: "authorized", latestRevisionId: positive.latestRevisionId, latestRevisionNumber: 4 });
      expect(positive.latestRevisionId).not.toBe(winner.latestRevisionId);

      raceArrivals = 0;
      raceGate = new Promise<void>((resolve, reject) => {
        releaseRace = () => { clearTimeout(raceTimer); resolve(); };
        raceTimer = setTimeout(() => reject(new Error(`Independent writer rendezvous timed out after ${raceArrivals} arrivals`)), 5_000);
      });
      startedCases.add("independent-writer-race");
      const pluginWrite = call("getData", { key: "write", companyId, params: { body: "plugin-writer", baseRevisionId: positive.latestRevisionId } });
      const independentWrite = (async () => {
        if (++raceArrivals === 2) releaseRace?.();
        await raceGate;
        const result = await documentService(db).upsertIssueDocument({ issueId, key: "plan", format: "markdown", body: "independent-writer", baseRevisionId: positive.latestRevisionId });
        return result.document;
      })();
      const mixedOutcomes = await Promise.allSettled([pluginWrite, independentWrite]);
      raceGate = undefined;
      const mixedReadback = await handlers["issues.documents.get"]({ companyId, issueId, key: "plan" }, { invocationScope: { companyId } } as any);
      const unrelatedReadback = await handlers["issues.documents.get"]({ companyId, issueId, key: "new-plan" }, { invocationScope: { companyId } } as any);
      console.info("independent-writer-race", JSON.stringify({ baseRevision: positive.latestRevisionId, outcomes: mixedOutcomes.map((outcome) => outcome.status === "fulfilled" ? { status: outcome.status, body: outcome.value.body, revision: outcome.value.latestRevisionId } : { status: outcome.status, error: String(outcome.reason) }), readback: mixedReadback, unrelatedReadback }));
      expect(raceArrivals).toBe(2);
      const mixedWinners = mixedOutcomes.filter((outcome) => outcome.status === "fulfilled");
      expect(mixedWinners).toHaveLength(1);
      expect(mixedOutcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      const mixedWinner = (mixedWinners[0] as PromiseFulfilledResult<any>).value;
      expect(["plugin-writer", "independent-writer"]).toContain(mixedWinner.body);
      expect(mixedReadback).toMatchObject({ key: "plan", body: mixedWinner.body, latestRevisionId: mixedWinner.latestRevisionId, latestRevisionNumber: 5 });
      expect(mixedWinner.latestRevisionId).not.toBe(positive.latestRevisionId);
      expect(unrelatedReadback).toMatchObject({ key: "new-plan", body: createWinner.body, latestRevisionId: createWinner.latestRevisionId, latestRevisionNumber: 1 });

      startedCases.add("dropped-reply-readback");
      let dropTimer: ReturnType<typeof setTimeout> | undefined;
      const replyDropped = new Promise<void>((resolve, reject) => {
        notifyDroppedReply = () => { clearTimeout(dropTimer); resolve(); };
        dropTimer = setTimeout(() => reject(new Error("Dropped-reply write did not reach the host")), 5_000);
      });
      dropNextWriteReply = true;
      let writeSettled = false;
      void call("getData", { key: "write", companyId, params: { body: "reply-lost", baseRevisionId: mixedWinner.latestRevisionId } })
        .then(() => { writeSettled = true; }, () => { writeSettled = true; });
      await replyDropped;
      const lostReplyReadback = await handlers["issues.documents.get"]({ companyId, issueId, key: "plan" }, { invocationScope: { companyId } } as any);
      const lostReplyUnrelated = await handlers["issues.documents.get"]({ companyId, issueId, key: "new-plan" }, { invocationScope: { companyId } } as any);
      console.info("dropped-reply-readback", JSON.stringify({ writeSettled, readback: lostReplyReadback, unrelatedReadback: lostReplyUnrelated }));
      expect(writeSettled).toBe(false);
      expect(lostReplyReadback).toMatchObject({ key: "plan", body: "reply-lost", latestRevisionNumber: 6 });
      expect(lostReplyReadback?.latestRevisionId).not.toBe(mixedWinner.latestRevisionId);
      expect(lostReplyUnrelated).toMatchObject({ key: "new-plan", body: createWinner.body, latestRevisionId: createWinner.latestRevisionId });
    }
  } finally {
    if (process.env.CUSTODY_EXPECTATION === "candidate") {
      console.info("candidate-case-reachability", JSON.stringify(candidateCases.map((name) => ({ name, started: startedCases.has(name) }))));
    }
    worker.stop();
    lines.close();
    input.destroy();
    output.destroy();
    services.dispose();
  }
}, 60_000);
