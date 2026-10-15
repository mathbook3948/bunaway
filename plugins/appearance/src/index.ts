import { defineNativePlugin } from "@bunaway/plugin";
import { appearanceEvents } from "#appearance/contract";
import {
  appearanceOperations,
  windowsAppearanceOperations,
} from "#appearance/operations";
import {
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "#appearance/platforms/macos";
import {
  dispose as disposeWindows,
  initialize as initializeWindows,
} from "#appearance/platforms/windows";
/** Query OS appearance, observe changes and control Windows native frame preferences. */
export default defineNativePlugin(
  {
    name: "appearance",
    events: appearanceEvents,
    platforms: {
      macos: {
        thread: "ui",
        initialize: initializeMacos,
        dispose: disposeMacos,
        operations: appearanceOperations,
      },
      windows: {
        thread: "ui",
        initialize: initializeWindows,
        dispose: disposeWindows,
        operations: windowsAppearanceOperations,
      },
    },
  },
  (api) => ({
    ...api,
    getPreferences: (options?: import("@bunaway/plugin").NativeInvokeOptions) =>
      api.getPreferences(null, options),
  }),
);

export type {
  AppearancePreferences,
  ThemePreference,
  ThemeState,
} from "#appearance/contract";
