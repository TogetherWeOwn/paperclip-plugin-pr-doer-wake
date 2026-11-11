import { definePlugin } from "@paperclipai/plugin-sdk";
import { UUID, validateCiConfig } from "./ci-config.js";
import { CiWakeRuntime } from "./ci-runtime.js";
import { registrationTool } from "./manifest.js";
import { CustodyRuntime } from "./custody-runtime.js";
import { validateCustodyConfig } from "./custody-config.js";

let runtime: CiWakeRuntime | null = null;
let custodyRuntime: CustodyRuntime | null = null;
// Last validated capture, retained across setup re-runs and applied to each
// fresh runtime so a capture is never lost when the runtime is recreated.
let capturedCustodyCompanyId: string | null = null;
function ready(): CiWakeRuntime {
  if (!runtime) throw new Error("ci-wake_not_initialized");
  return runtime;
}
function readyCustody(): CustodyRuntime {
  if (!custodyRuntime) throw new Error("custody_not_initialized");
  return custodyRuntime;
}

export default definePlugin({
  async setup(ctx) {
    runtime = new CiWakeRuntime(ctx);
    custodyRuntime = new CustodyRuntime(ctx);
    custodyRuntime.setCustodyCompanyId(capturedCustodyCompanyId);
    // Dereference the module-level runtime at fire time so a setup re-run
    // retargets the already-registered job instead of splitting it from the
    // runtime that onConfigChanged mutates.
    ctx.jobs.register("pr-custody", async () => readyCustody().poll());
    // Keep the bounded PR->card index fresh between scheduled ticks. The
    // scheduled job remains the reconciler; events only accelerate it.
    const custodyEvent = async (event: { companyId: string; entityId?: string; eventType: string }) => readyCustody().onCustodyEvent(event);
    ctx.events.on("issue.created", custodyEvent);
    ctx.events.on("issue.updated", custodyEvent);
    ctx.events.on("issue.comment.created", custodyEvent);
    ctx.events.on("issue.document.created", custodyEvent);
    ctx.events.on("issue.document.updated", custodyEvent);
    ctx.events.on("issue.relations.updated", custodyEvent);
    ctx.tools.register(registrationTool.name, registrationTool, (params, run) => ready().register(params, run));
    ctx.jobs.register("ci-wake-poll", async () => ready().poll());
    ctx.logger.info("ci-wake ready; explicit registration only");
  },
  // The host replays stored company config through configChanged (including at
  // worker startup, before scheduled jobs register). Capture custodyCompanyId
  // here so the scheduled pr-custody job can read config explicitly scoped;
  // there is no other stock channel that delivers it to a job handler.
  // The capture is bound to the host-supplied delivery scope, never to the
  // self-declared config field alone: capture only when the delivery's
  // companyId equals the config's custodyCompanyId. An unscoped delivery, or
  // one from a different company whose field does not name itself, neither
  // retargets nor clears the capture; only a delivery from the currently
  // captured company that no longer names itself clears it.
  async onConfigChanged(newConfig, context) {
    const delivered = typeof context?.companyId === "string" && UUID.test(context.companyId)
      ? context.companyId.toLowerCase()
      : null;
    if (!delivered) return;
    const field = newConfig.custodyEnabled === true && typeof newConfig.custodyCompanyId === "string" && UUID.test(newConfig.custodyCompanyId)
      ? newConfig.custodyCompanyId.toLowerCase()
      : null;
    if (field === delivered) {
      capturedCustodyCompanyId = delivered;
      custodyRuntime?.setCustodyCompanyId(delivered);
      return;
    }
    if (capturedCustodyCompanyId !== null && delivered === capturedCustodyCompanyId) {
      capturedCustodyCompanyId = null;
      custodyRuntime?.setCustodyCompanyId(null);
    }
  },
  async onValidateConfig(config) {
    const errors = [...validateCiConfig(config), ...validateCustodyConfig(config)];
    return errors.length ? { ok: false, errors } : { ok: true };
  },
  async onWebhook(input) { await ready().webhook(input); },
  async onHealth() { return { status: "ok", message: "ci-wake ready; inspect wait audits and Actions/operational evidence separately" }; },
});
