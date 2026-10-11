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

/** Optional text clipboard contract; registration does not grant permissions. */
export const clipboardPlugin = plugin.definition;
export default clipboardPlugin;

/** Read Unicode text, replace all formats with text, or clear all clipboard formats. */
export const clipboard = plugin.api;
