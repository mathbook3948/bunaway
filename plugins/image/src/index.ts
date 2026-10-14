import { defineNativePlugin } from "@bunaway/plugin";
import { imageOperations } from "./operations.ts";
import {
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "./platforms/macos.ts";
import {
  dispose as disposeWindows,
  initialize as initializeWindows,
} from "./platforms/windows.ts";

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
