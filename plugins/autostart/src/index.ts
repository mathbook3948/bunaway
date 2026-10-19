import { defineNativePlugin } from "@bunaway/plugin";
import { createAutostart } from "#autostart/calls";
import {
  autostartOperations,
  macosAutostartOperations,
} from "#autostart/operations";
import { initialize as initializeMacos } from "#autostart/platforms/macos";
import { dispose, initialize } from "#autostart/platforms/windows";
/**
 * Optional user-scoped login registration: the Windows Run key and the macOS LaunchAgent.
 * Importing does not register the app.
 */
export default defineNativePlugin(
  {
    name: "autostart",
    platforms: {
      macos: {
        initialize: initializeMacos,
        operations: macosAutostartOperations,
      },
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
