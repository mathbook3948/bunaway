import { defineNativePlugin } from "@bunaway/plugin";
import { globalShortcutEvents } from "./contract.ts";
import { globalShortcutOperations } from "./operations.ts";
import { dispose, initialize } from "./platforms/windows.ts";

/** Register, inspect, remove and suspend app-owned Windows global shortcuts. */
export default defineNativePlugin({
  events: {
    "globalShortcut.pressed":
      globalShortcutEvents["globalShortcut.pressed"].payload,
  },
  name: "globalShortcut",
  platforms: {
    windows: {
      thread: "ui",
      initialize,
      dispose,
      operations: globalShortcutOperations,
    },
  },
});

export type { GlobalShortcut } from "./contract.ts";
