import { defineNativePlugin } from "@bunaway/plugin";
import { appearanceOperations } from "./contract.ts";
import { createOperations as createMacosOperations } from "./platforms/macos.ts";
import { createOperations } from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "appearance",
  platforms: {
    macos: {
      execution: "ui",
      create: createMacosOperations,
    },
    windows: {
      execution: "io",
      create: createOperations,
    },
  },
  operations: appearanceOperations,
});
/** Read OS appearance and accessibility preferences with an independent operation grant. */
export const appearancePlugin = plugin.definition;
export default appearancePlugin;
/** Query preferences. Theme overrides and accessibility support control are separate host features. */
export const appearance = Object.freeze({
  getPreferences: (options?: import("@bunaway/plugin").NativeInvokeOptions) =>
    plugin.api.getPreferences(null, options),
});
export type { AppearancePreferences } from "./contract.ts";
