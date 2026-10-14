import { defineNativePlugin } from "@bunaway/plugin";
import { processOperations } from "./operations.ts";
import { dispose, initialize } from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "process",
  platforms: {
    windows: {
      thread: "ui",
      initialize,
      dispose,
      operations: processOperations,
    },
  },
});
/** Optional argv-based process plugin; registration grants no executable access. */
export const processPlugin = plugin.definition;
export default processPlugin;
/** Run one bounded process without a shell or persistent process handle. */
export const processes = plugin.api;
export type { ProcessInput, ProcessResult } from "./contract.ts";
