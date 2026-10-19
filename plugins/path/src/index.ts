import { defineNativePlugin } from "@bunaway/plugin";
import { macosPathOperations } from "#path/macos-operations";
import { pathOperations } from "#path/operations";
import { initialize as initializeMacos } from "#path/platforms/macos";
import { dispose, initialize } from "#path/platforms/windows";
/** Promise-based lexical path helpers and current-user and app-specific directory queries. */
export default defineNativePlugin({
  name: "path",
  platforms: {
    windows: {
      initialize,
      dispose,
      operations: pathOperations,
    },
    macos: {
      initialize: initializeMacos,
      operations: macosPathOperations,
    },
  },
});

export type { AppDirectory, UserDirectory } from "#path/contract";
