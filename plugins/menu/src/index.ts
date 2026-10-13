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
  events: menuEvents,
});
/** App-scoped menu resources; each operation requires its own policy permission. */
export const menuPlugin = plugin.definition;
export default menuPlugin;
/** Typed menu resource and tray attachment operations. */
export const menu = plugin.api;
