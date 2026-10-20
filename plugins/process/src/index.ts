import { defineNativePlugin } from "@bunaway/plugin";
import { macosProcessOperations, processOperations } from "#process/operations";
import {
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "#process/platforms/macos";
import { dispose, initialize } from "#process/platforms/windows";

/**
 * Run one bounded process without a shell, on Windows and macOS. Windows also keeps long-running
 * children behind handles: `spawn` starts one, `read` pulls its output and exit, `write` and
 * `closeStdin` feed stdin, and `kill` ends its process tree. Each operation needs its own grant.
 */
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
