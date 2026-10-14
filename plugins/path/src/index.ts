import { defineNativePlugin } from "@bunaway/plugin";
import { pathOperations } from "./operations.ts";
import { dispose, initialize } from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "path",
  platforms: {
    windows: {
      initialize,
      dispose,
      operations: pathOperations,
    },
  },
});
/** Optional Windows path and current-user known folder contract. */
export const pathPlugin = plugin.definition;
export default pathPlugin;
/** Promise-based Windows lexical path helpers and current-user directory queries. */
export const path = plugin.api;
export type { UserDirectory } from "./contract.ts";
