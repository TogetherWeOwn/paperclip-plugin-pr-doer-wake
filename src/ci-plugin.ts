import { definePlugin } from "@paperclipai/plugin-sdk";
import { validateCiConfig } from "./ci-config.js";
import { CiWakeRuntime } from "./ci-runtime.js";
import { registrationTool } from "./manifest.js";
import { CustodyRuntime } from "./custody-runtime.js";
import { validateCustodyConfig } from "./custody-config.js";

let runtime: CiWakeRuntime | null = null;
let custodyRuntime: CustodyRuntime | null = null;
function ready(): CiWakeRuntime {
  if (!runtime) throw new Error("ci-wake_not_initialized");
  return runtime;
}

export default definePlugin({
  async setup(ctx) {
    runtime = new CiWakeRuntime(ctx);
    custodyRuntime = new CustodyRuntime(ctx);
    const custody = custodyRuntime;
    ctx.jobs.register("pr-custody", async () => custody.poll());
    ctx.tools.register(registrationTool.name, registrationTool, (params, run) => ready().register(params, run));
    ctx.jobs.register("ci-wake-poll", async () => ready().poll());
    ctx.logger.info("ci-wake ready; explicit registration only");
  },
  // The host replays stored company config through configChanged (including at
  // worker startup, before scheduled jobs register). Capture custodyCompanyId
  // here so the scheduled pr-custody job can read config explicitly scoped;
  // there is no other stock channel that delivers it to a job handler.
  async onConfigChanged(newConfig, context) {
    const custodyCompanyId = newConfig.custodyEnabled === true && typeof newConfig.custodyCompanyId === "string"
      ? newConfig.custodyCompanyId
      : null;
    custodyRuntime?.setCustodyCompanyId(custodyCompanyId);
  },
  async onValidateConfig(config) {
    const errors = [...validateCiConfig(config), ...validateCustodyConfig(config)];
    return errors.length ? { ok: false, errors } : { ok: true };
  },
  async onWebhook(input) { await ready().webhook(input); },
  async onHealth() { return { status: "ok", message: "ci-wake ready; inspect wait audits and Actions/operational evidence separately" }; },
});
