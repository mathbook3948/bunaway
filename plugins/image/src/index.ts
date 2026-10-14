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

const plugin = defineNativePlugin({
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
/** Optional image resources; registration grants no operations or filesystem access. */
export const imagePlugin = plugin.definition;
export default imagePlugin;
/** Create, query, encode and explicitly dispose app-owned image resources. */
export const image = plugin.api;
