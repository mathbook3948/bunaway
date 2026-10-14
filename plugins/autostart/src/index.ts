import { defineNativePlugin } from "@bunaway/plugin";
import { createAutostart } from "./calls.ts";
import { autostartOperations } from "./operations.ts";
import { dispose, initialize } from "./platforms/windows.ts";

/** Optional user-scoped Windows login registration. Importing does not register the app. */
export default defineNativePlugin(
  {
    name: "autostart",
    platforms: {
      windows: {
        initialize,
        dispose,
        operations: autostartOperations,
      },
    },
  },
  createAutostart,
);

export type { AutostartOptions, AutostartStatus } from "./contract.ts";
