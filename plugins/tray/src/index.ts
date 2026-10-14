import { defineNativePlugin } from "@bunaway/plugin";
import { trayEvents } from "#tray/contract";
import { trayOperations } from "#tray/operations";
import { dispose, initialize } from "#tray/platforms/windows";
/** Query/update the configured tray and wait for input without requiring a view. */
export default defineNativePlugin({
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
