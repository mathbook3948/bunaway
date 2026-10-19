import { defineNativePlugin } from "@bunaway/plugin";
import { macosProcessOperations, processOperations } from "#process/operations";
import {
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "#process/platforms/macos";
import { dispose, initialize } from "#process/platforms/windows";

/** Run one bounded process without a shell or persistent process handle. */
export default defineNativePlugin({
  name: "process",
  platforms: {
    macos: {
      thread: "ui",
      initialize: initializeMacos,
      dispose: disposeMacos,
      operations: macosProcessOperations,
    },
    windows: {
      thread: "ui",
      initialize,
      dispose,
      operations: processOperations,
    },
  },
});

export type { ProcessInput, ProcessResult } from "#process/contract";
