import { defineNativePlugin } from "@bunaway/plugin";
import { appearanceOperations } from "#appearance/operations";
import {
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "#appearance/platforms/macos";
import {
  dispose as disposeWindows,
  initialize as initializeWindows,
} from "#appearance/platforms/windows";
/** Query preferences. Theme overrides and accessibility support control are separate host features. */
export default defineNativePlugin(
  {
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
  },
  (api) => ({
    getPreferences: (options?: import("@bunaway/plugin").NativeInvokeOptions) =>
      api.getPreferences(null, options),
  }),
);

export type { AppearancePreferences } from "#appearance/contract";
