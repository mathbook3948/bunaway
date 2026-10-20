import { defineNativePlugin } from "@bunaway/plugin";
import { dialogOperations } from "#dialog/operations";
import {
  busy as busyMacos,
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "#dialog/platforms/macos";
import {
  busy as busyWindows,
  dispose as disposeWindows,
  initialize as initializeWindows,
} from "#dialog/platforms/windows";
/** Select filesystem paths and show message or confirmation dialogs, each behind its own grant. Windows and macOS implement every operation. */
export default defineNativePlugin({
  name: "dialog",
  platforms: {
    macos: {
      thread: "ui",
      initialize: initializeMacos,
      dispose: disposeMacos,
      busy: busyMacos,
      operations: dialogOperations,
    },
    windows: {
      thread: "ui",
      initialize: initializeWindows,
      dispose: disposeWindows,
      busy: busyWindows,
      operations: dialogOperations,
    },
  },
});
