import { defineNativePlugin } from "@bunaway/plugin";
import { imageOperations } from "./contract.ts";
import { createOperations as createMacosOperations } from "./platforms/macos.ts";
import { createOperations as createWindowsOperations } from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "image",
  platforms: {
    macos: {
      execution: "io",
      create: createMacosOperations,
    },
    windows: {
      execution: "ui",
      create: createWindowsOperations,
    },
  },
  operations: imageOperations,
});
/** Optional image resources; registration grants no operations or filesystem access. */
export const imagePlugin = plugin.definition;
export default imagePlugin;
/** Create, query, encode and explicitly dispose app-owned image resources. */
export const image = plugin.api;
