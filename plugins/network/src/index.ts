import { defineNativePlugin } from "@bunaway/plugin";
import { macosOperations, windowsOperations } from "./operations.ts";
import {
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "./platforms/macos.ts";
import {
  dispose as disposeWindows,
  initialize as initializeWindows,
} from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "network",
  platforms: {
    macos: {
      thread: "ui",
      initialize: initializeMacos,
      dispose: disposeMacos,
      operations: macosOperations,
    },
    windows: {
      thread: "ui",
      initialize: initializeWindows,
      dispose: disposeWindows,
      operations: windowsOperations,
    },
  },
});
/** Optional network plugin. Applications authorize URLs in their own commands. */
export const networkPlugin = plugin.definition;
export default networkPlugin;
/** Bounded HTTP requests and WebSocket exchanges. Cancellation releases in-flight resources. */
export const network = plugin.api;
export type { NetworkRequest, NetworkResponse } from "./contract.ts";
