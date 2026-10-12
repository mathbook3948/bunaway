import { defineNativePlugin } from "@bunaway/plugin";
import { menuEvents, menuOperations } from "./contract.ts";
import { createOperations } from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "menu",
  platforms: {
    windows: {
      execution: "ui",
      create: createOperations,
    },
  },
  operations: menuOperations,
});
/** App-scoped menu resources; each operation requires its own policy permission. */
export const menuPlugin = Object.freeze({
  ...plugin.definition,
  events: menuEvents,
});
export default menuPlugin;
/** Typed menu resource and tray attachment operations. */
export const menu = plugin.api;
