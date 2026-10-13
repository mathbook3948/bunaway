import { defineNativePlugin } from "@bunaway/plugin";
import { networkOperations } from "./contract.ts";
import { createOperations } from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "network",
  operations: networkOperations,
  platforms: {
    windows: {
      execution: "ui",
      create: createOperations,
    },
  },
});
/** Optional network plugin. Applications authorize URLs in their own commands. */
export const networkPlugin = plugin.definition;
export default networkPlugin;
/** Bounded HTTP requests and WebSocket exchanges. Cancellation releases in-flight resources. */
export const network = plugin.api;
export type { NetworkRequest, NetworkResponse } from "./contract.ts";
