import { defineNativePlugin } from "@bunaway/plugin";
import { processOperations } from "./operations.ts";
import { dispose, initialize } from "./platforms/windows.ts";

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

export type { ProcessInput, ProcessResult } from "./contract.ts";
