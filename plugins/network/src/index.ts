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

/** Bounded HTTP requests and WebSocket exchanges. Cancellation releases in-flight resources. */
export default defineNativePlugin({
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

export type { NetworkRequest, NetworkResponse } from "./contract.ts";
