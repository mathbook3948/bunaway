import { defineNativePlugin } from "@bunaway/plugin";
import { globalShortcutEvents } from "#global-shortcut/contract";
import { globalShortcutOperations } from "#global-shortcut/operations";
import {
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "#global-shortcut/platforms/macos";
import {
  dispose as disposeWindows,
  initialize as initializeWindows,
} from "#global-shortcut/platforms/windows";
/**
 * Register, inspect, remove and suspend app-owned global shortcuts on Windows and macOS. On macOS
 * `Super` is Command and `Alt` is Option, `Insert` and `F21` to `F24` are rejected as unsupported,
 * and no Accessibility permission is needed.
 */
export default defineNativePlugin({
  events: {
    "globalShortcut.pressed":
      globalShortcutEvents["globalShortcut.pressed"].payload,
    "globalShortcut.released":
      globalShortcutEvents["globalShortcut.released"].payload,
  },
  name: "globalShortcut",
  platforms: {
    macos: {
      thread: "ui",
      initialize: initializeMacos,
      dispose: disposeMacos,
      operations: globalShortcutOperations,
    },
    windows: {
      thread: "ui",
      initialize: initializeWindows,
      dispose: disposeWindows,
      operations: globalShortcutOperations,
    },
  },
});

export type { GlobalShortcut } from "#global-shortcut/contract";
