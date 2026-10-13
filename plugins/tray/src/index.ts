import { defineNativePlugin } from "@bunaway/plugin";
import { trayEvents, trayOperations } from "./contract.ts";
import { createOperations } from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "tray",
  platforms: {
    windows: {
      execution: "ui",
      create: createOperations,
    },
  },
  operations: trayOperations,
  events: trayEvents,
});
/** Optional controls and notifications for the app's configured Windows tray. */
export const trayPlugin = plugin.definition;
export default trayPlugin;
/** Query/update the configured tray and wait for input without requiring a view. */
export const tray = plugin.api;
