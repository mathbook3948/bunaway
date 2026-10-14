import { defineNativePlugin } from "@bunaway/plugin";
import { createAutostart } from "./calls.ts";
import { autostartOperations } from "./operations.ts";
import { dispose, initialize } from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "autostart",
  platforms: {
    windows: {
      initialize,
      dispose,
      operations: autostartOperations,
    },
  },
});

/** Optional user-scoped Windows login registration. Importing does not register the app. */
export const autostartPlugin = plugin.definition;
export default autostartPlugin;

export type { AutostartOptions, AutostartStatus } from "./contract.ts";

const calls = createAutostart(plugin.api);
/**
 * Replace this app's Run value with the host-selected launch and these app arguments.
 * Adds invocation metadata and optionally starts hidden when desktop.tray is configured.
 * Preserves Windows startup approval, including the user's disabled choice.
 * Rejects a complete encoded command line longer than 260 UTF-16 code units.
 */
export const enableAutostart = calls.enableAutostart;
/** Delete only this app's Run value. Repeated removal succeeds; approval is not changed. */
export const disableAutostart = calls.disableAutostart;
/** Read the real stored path and arguments without repairing or enabling the registration. */
export const getAutostartStatus = calls.getAutostartStatus;
