import { defineNativePlugin } from "@bunaway/plugin";
import { trayEvents } from "./contract.ts";
import { trayOperations } from "./operations.ts";
import { dispose, initialize } from "./platforms/windows.ts";

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
