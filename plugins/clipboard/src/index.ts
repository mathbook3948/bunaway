import { defineNativePlugin } from "@bunaway/plugin";
import { clipboardOperations } from "./contract.ts";
import { createOperations as createMacosOperations } from "./platforms/macos.ts";
import { createOperations as createWindowsOperations } from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "clipboard",
  platforms: {
    macos: {
      execution: "ui",
      create: createMacosOperations,
      operations: [
        "readText",
        "writeText",
        "clear",
        "readImage",
        "writeImage",
        "getFormats",
        "hasFormat",
        "readFormats",
        "writeFormats",
      ],
    },
    windows: {
      execution: "ui",
      create: createWindowsOperations,
    },
  },
  operations: clipboardOperations,
});

/** Optional clipboard contract; registration does not grant permissions. */
export const clipboardPlugin = plugin.definition;
export default clipboardPlugin;

/** Read, replace, discover or clear bounded platform clipboard formats. */
export const clipboard = plugin.api;
