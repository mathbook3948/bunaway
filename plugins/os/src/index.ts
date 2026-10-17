import { defineNativePlugin } from "@bunaway/plugin";
import { osOperations } from "#os/operations";
import { dispose, initialize } from "#os/platforms/windows";
/** Read OS and bundled Bun metadata. Architecture describes the running process. */
export default defineNativePlugin({
  name: "os",
  platforms: {
    windows: {
      initialize,
      dispose,
      operations: osOperations,
    },
  },
});

export type { OSBeepInput, OSInfo, OSLocale, OSUsage } from "#os/contract";
