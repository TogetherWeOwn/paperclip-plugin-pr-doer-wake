import { definePlugin } from "@paperclipai/plugin-sdk";
import { validateCiConfig } from "./ci-config.js";
import { CiWakeRuntime } from "./ci-runtime.js";
import { GatesStatusRuntime } from "./gates-runtime.js";
import { registrationTool } from "./manifest.js";
import { CustodyRuntime } from "./custody-runtime.js";
import { validateCustodyConfig } from "./custody-config.js";

let runtime: CiWakeRuntime | null = null;
let gates: GatesStatusRuntime | null = null;
function ready(): CiWakeRuntime {
  if (!runtime) throw new Error("ci-wake_not_initialized");
  return runtime;
}
function readyGates(): GatesStatusRuntime {
  if (!gates) throw new Error("gates_not_initialized");
  return gates;
}

export default definePlugin({
  async setup(ctx) {
    runtime = new CiWakeRuntime(ctx);
    gates = new GatesStatusRuntime(ctx);
    const custody = new CustodyRuntime(ctx);
    ctx.jobs.register("pr-custody", async () => custody.poll());
    ctx.tools.register(registrationTool.name, registrationTool, (params, run) => ready().register(params, run));
    ctx.jobs.register("ci-wake-poll", async () => ready().poll());
    ctx.jobs.register("gates-status-sweep", async () => readyGates().drain());
    ctx.events.on("issue.updated", async (event) => readyGates().handleIssueUpdated(event));
    ctx.logger.info("ci-wake ready; explicit registration only; gates publisher registered (disabled by default)");
  },
  async onValidateConfig(config) {
    const errors = [...validateCiConfig(config), ...validateCustodyConfig(config)];
    return errors.length ? { ok: false, errors } : { ok: true };
  },
  async onWebhook(input) { await ready().webhook(input); },
  async onHealth() { return { status: "ok", message: "ci-wake ready; inspect wait audits and Actions/operational evidence separately" }; },
});
