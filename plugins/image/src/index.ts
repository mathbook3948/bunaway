import { defineNativePlugin } from "@bunaway/plugin";
import { imageOperations } from "#image/operations";
import {
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "#image/platforms/macos";
import {
  dispose as disposeWindows,
  initialize as initializeWindows,
} from "#image/platforms/windows";
/** Create, query, encode and explicitly dispose app-owned image resources. */
export default defineNativePlugin({
  name: "image",
  platforms: {
    macos: {
      initialize: initializeMacos,
      dispose: disposeMacos,
      operations: imageOperations,
    },
    windows: {
      thread: "ui",
      initialize: initializeWindows,
      dispose: disposeWindows,
      operations: imageOperations,
    },
  },
});
