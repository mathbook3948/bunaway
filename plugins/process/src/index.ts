import { defineNativePlugin } from "@bunaway/plugin";
import { processOperations } from "#process/operations";
import { dispose, initialize } from "#process/platforms/windows";
/** Run one bounded process without a shell or persistent process handle. */
export default defineNativePlugin({
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

export type { ProcessInput, ProcessResult } from "#process/contract";
