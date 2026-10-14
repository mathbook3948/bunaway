import { defineNativePlugin } from "@bunaway/plugin";
import { trayEvents } from "./contract.ts";
import { trayOperations } from "./operations.ts";
import { dispose, initialize } from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "tray",
  platforms: {
    windows: {
      thread: "ui",
      initialize,
      dispose,
      operations: trayOperations,
    },
  },
  events: trayEvents,
});
/** Optional controls and notifications for the app's configured Windows tray. */
export const trayPlugin = plugin.definition;
export default trayPlugin;
/** Query/update the configured tray and wait for input without requiring a view. */
export const tray = plugin.api;
