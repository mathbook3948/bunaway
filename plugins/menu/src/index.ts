import { defineNativePlugin } from "@bunaway/plugin";
import { menuEvents } from "./contract.ts";
import { menuOperations } from "./operations.ts";
import { dispose, initialize } from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "menu",
  platforms: {
    windows: {
      thread: "ui",
      initialize,
      dispose,
      operations: menuOperations,
    },
  },
  events: menuEvents,
});
/** App-scoped menu resources; each operation requires its own policy permission. */
export const menuPlugin = plugin.definition;
export default menuPlugin;
/** Typed menu resource and tray attachment operations. */
export const menu = plugin.api;
