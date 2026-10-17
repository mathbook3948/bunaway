import { defineNativePlugin } from "@bunaway/plugin";
import { clipboardEvents } from "#clipboard/contract";
import { macosOperations, windowsOperations } from "#clipboard/operations";
import {
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "#clipboard/platforms/macos";
import {
  busy as busyWindows,
  dispose as disposeWindows,
  initialize as initializeWindows,
} from "#clipboard/platforms/windows";
/** Read, replace, discover or clear bounded platform clipboard formats. */
export default defineNativePlugin({
  events: {
    "clipboard.changed": clipboardEvents["clipboard.changed"].payload,
  },
  name: "clipboard",
  platforms: {
    macos: {
      thread: "ui",
      initialize: initializeMacos,
      dispose: disposeMacos,
      operations: macosOperations,
    },
    windows: {
      thread: "ui",
      initialize: initializeWindows,
      dispose: disposeWindows,
      busy: busyWindows,
      operations: windowsOperations,
    },
  },
});
