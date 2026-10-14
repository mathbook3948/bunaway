import { defineNativePlugin } from "@bunaway/plugin";
import { pathOperations } from "./operations.ts";
import { dispose, initialize } from "./platforms/windows.ts";

/** Promise-based Windows lexical path helpers and current-user directory queries. */
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

export type { UserDirectory } from "./contract.ts";
