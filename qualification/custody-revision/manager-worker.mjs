// Copied beside the upstream server tests; executed as a separate worker process.
// Use the pinned SDK's worker host rather than a fixture-side RPC bridge.
import { definePlugin, startWorkerRpcHost } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register("write", async (params) => ctx.issues.documents.upsert({
      companyId: params.targetCompanyId,
      issueId: params.issueId,
      key: params.documentKey,
      body: params.body,
      baseRevisionId: params.baseRevisionId,
    }));
  },
});

startWorkerRpcHost({ plugin });
