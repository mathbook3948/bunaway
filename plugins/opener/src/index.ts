import { defineNativePlugin } from "@bunaway/plugin";
import { createOpener } from "./calls.ts";
import { macosOperations, windowsOperations } from "./operations.ts";
import {
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "./platforms/macos.ts";
import {
  dispose as disposeWindows,
  initialize as initializeWindows,
} from "./platforms/windows.ts";

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
