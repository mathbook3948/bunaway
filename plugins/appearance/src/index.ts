import { defineNativePlugin } from "@bunaway/plugin";
import { appearanceOperations } from "./operations.ts";
import {
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "./platforms/macos.ts";
import {
  dispose as disposeWindows,
  initialize as initializeWindows,
} from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "appearance",
  platforms: {
    macos: {
      thread: "ui",
      initialize: initializeMacos,
      dispose: disposeMacos,
      operations: appearanceOperations,
    },
    windows: {
      initialize: initializeWindows,
      dispose: disposeWindows,
      operations: appearanceOperations,
    },
  },
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
