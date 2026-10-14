import { defineNativePlugin } from "@bunaway/plugin";
import { macosOperations, windowsOperations } from "./operations.ts";
import {
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "./platforms/macos.ts";
import {
  busy as busyWindows,
  dispose as disposeWindows,
  initialize as initializeWindows,
} from "./platforms/windows.ts";

/** Read, replace, discover or clear bounded platform clipboard formats. */
export default defineNativePlugin({
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
