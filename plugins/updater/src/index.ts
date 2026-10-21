import { defineNativePlugin } from "@bunaway/plugin";
import { updaterOperations } from "#updater/operations";
import {
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "#updater/platforms/macos";
import {
  dispose as disposeWindows,
  initialize as initializeWindows,
} from "#updater/platforms/windows";
/** Compare the running app version with the update manifest at the endpoint the app fixed in bunaway.json. */
export default defineNativePlugin({
  name: "updater",
  platforms: {
    macos: {
      initialize: initializeMacos,
      dispose: disposeMacos,
      operations: updaterOperations,
    },
    windows: {
      initialize: initializeWindows,
      dispose: disposeWindows,
      operations: updaterOperations,
    },
  },
});

export type { UpdaterCheckResult } from "#updater/contract";
