import { defineNativePlugin } from "@bunaway/plugin";
import { menuEvents } from "#menu/contract";
import { menuOperations } from "#menu/operations";
import { dispose, initialize } from "#menu/platforms/windows";
/** Typed menu resource and tray attachment operations. */
export default defineNativePlugin({
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
