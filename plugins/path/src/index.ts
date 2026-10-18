import { defineNativePlugin } from "@bunaway/plugin";
import { pathOperations } from "#path/operations";
import { dispose, initialize } from "#path/platforms/windows";
/** Promise-based Windows lexical path helpers and current-user and app-specific directory queries. */
export default defineNativePlugin({
  name: "path",
  platforms: {
    windows: {
      initialize,
      dispose,
      operations: pathOperations,
    },
  },
});

export type { AppDirectory, UserDirectory } from "#path/contract";
