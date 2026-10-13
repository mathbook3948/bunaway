import { defineNativePlugin, type NativeInvokeOptions } from "@bunaway/plugin";
import { powerOperations } from "./contract.ts";
import { createOperations } from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "power",
  platforms: {
    windows: {
      execution: "io",
      create: createOperations,
    },
  },
  operations: powerOperations,
});
/** Optional Windows power and idle queries, and app-owned sleep/display requests. */
export const powerPlugin = plugin.definition;
export default powerPlugin;
/** Each operation needs its own grant. Repeated starts allocate independently stoppable requests. */
export const power = Object.freeze({
  ...plugin.api,
  getStatus: (options?: NativeInvokeOptions) =>
    plugin.api.getStatus(null, options),
  getIdleTime: (options?: NativeInvokeOptions) =>
    plugin.api.getIdleTime(null, options),
  listBlockers: (options?: NativeInvokeOptions) =>
    plugin.api.listBlockers(null, options),
});
export type {
  PowerBlocker,
  PowerBlockerType,
  PowerStatus,
} from "./contract.ts";
