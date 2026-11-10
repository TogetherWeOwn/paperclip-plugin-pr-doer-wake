import { runWorker } from "@paperclipai/plugin-sdk";
import plugin from "./ci-plugin.js";

export default plugin;
runWorker(plugin, import.meta.url);
