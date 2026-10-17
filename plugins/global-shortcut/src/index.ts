import { defineNativePlugin } from "@bunaway/plugin";
import { globalShortcutEvents } from "#global-shortcut/contract";
import { globalShortcutOperations } from "#global-shortcut/operations";
import { dispose, initialize } from "#global-shortcut/platforms/windows";
/** Register, inspect, remove and suspend app-owned Windows global shortcuts. */
export default defineNativePlugin({
  events: {
    "globalShortcut.pressed":
      globalShortcutEvents["globalShortcut.pressed"].payload,
    "globalShortcut.released":
      globalShortcutEvents["globalShortcut.released"].payload,
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

export type { GlobalShortcut } from "#global-shortcut/contract";
