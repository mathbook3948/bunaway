import { defineNativePlugin } from "@bunaway/plugin";
import { processOperations } from "./contract.ts";
import { createOperations } from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "process",
  operations: processOperations,
  platforms: {
    windows: {
      execution: "ui",
      create: createOperations,
    },
  },
});
/** Optional argv-based process plugin; registration grants no executable access. */
export const processPlugin = plugin.definition;
export default processPlugin;
/** Run one bounded process without a shell or persistent process handle. */
export const processes = plugin.api;
export type { ProcessInput, ProcessResult } from "./contract.ts";
