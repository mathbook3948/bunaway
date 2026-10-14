import { defineNativePlugin } from "@bunaway/plugin";
import { createAutostart } from "#autostart/calls";
import { autostartOperations } from "#autostart/operations";
import { dispose, initialize } from "#autostart/platforms/windows";
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

export type { AutostartOptions, AutostartStatus } from "#autostart/contract";
