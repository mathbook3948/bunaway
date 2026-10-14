import { defineNativePlugin } from "@bunaway/plugin";
import { createOpener } from "#opener/calls";
import { macosOperations, windowsOperations } from "#opener/operations";
import {
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "#opener/platforms/macos";
import {
  dispose as disposeWindows,
  initialize as initializeWindows,
} from "#opener/platforms/windows";
/** Plugin contract for validated files and HTTP and HTTPS URLs. */
export default defineNativePlugin(
  {
    name: "opener",
    platforms: {
      windows: {
        initialize: initializeWindows,
        dispose: disposeWindows,
        operations: windowsOperations,
      },
      macos: {
        initialize: initializeMacos,
        dispose: disposeMacos,
        operations: macosOperations,
      },
    },
  },
  createOpener,
);
