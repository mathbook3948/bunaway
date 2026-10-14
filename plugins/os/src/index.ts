import { defineNativePlugin } from "@bunaway/plugin";
import { osOperations } from "./operations.ts";
import { dispose, initialize } from "./platforms/windows.ts";

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

export type { OSInfo, OSLocale, OSUsage } from "./contract.ts";
