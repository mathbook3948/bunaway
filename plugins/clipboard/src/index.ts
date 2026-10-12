import { defineNativePlugin } from "@bunaway/plugin";
import { clipboardOperations } from "./contract.ts";
import { createOperations as createWindowsOperations } from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "clipboard",
  platforms: {
    windows: {
      execution: "ui",
      create: createWindowsOperations,
    },
  },
  operations: clipboardOperations,
});

/** Optional Windows clipboard contract; registration does not grant permissions. */
export const clipboardPlugin = plugin.definition;
export default clipboardPlugin;

/** Read, replace, discover or clear bounded Windows clipboard formats. */
export const clipboard = plugin.api;
