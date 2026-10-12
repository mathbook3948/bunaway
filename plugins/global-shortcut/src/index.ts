import { defineNativePlugin } from "@bunaway/plugin";
import { globalShortcutEvents, globalShortcutOperations } from "./contract.ts";
import { createOperations } from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "globalShortcut",
  platforms: {
    windows: {
      execution: "ui",
      create: createOperations,
    },
  },
  operations: globalShortcutOperations,
});
/** Optional global shortcuts; registration grants no operation or event permissions. */
export const globalShortcutPlugin = Object.freeze({
  ...plugin.definition,
  events: globalShortcutEvents,
});
export default globalShortcutPlugin;
/** Register, inspect, remove and suspend app-owned Windows global shortcuts. */
export const globalShortcut = plugin.api;
export type { GlobalShortcut } from "./contract.ts";
