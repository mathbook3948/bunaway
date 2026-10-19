import { defineNativePlugin } from "@bunaway/plugin";
import { trayEvents } from "#tray/contract";
import { trayOperations } from "#tray/operations";
import { macosTrayOperations } from "#tray/operations-macos";
import {
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "#tray/platforms/macos";
import { dispose, initialize } from "#tray/platforms/windows";
/** Windows configured tray controls and the macOS menu bar item, usable without a view. */
export default defineNativePlugin({
  name: "tray",
  platforms: {
    macos: {
      thread: "ui",
      initialize: initializeMacos,
      dispose: disposeMacos,
      operations: macosTrayOperations,
    },
    windows: {
      thread: "ui",
      initialize,
      dispose,
      operations: trayOperations,
    },
  },
  events: trayEvents,
});
