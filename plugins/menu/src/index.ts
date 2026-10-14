import { defineNativePlugin } from "@bunaway/plugin";
import { menuEvents } from "./contract.ts";
import { menuOperations } from "./operations.ts";
import { dispose, initialize } from "./platforms/windows.ts";

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
