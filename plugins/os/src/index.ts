import { defineNativePlugin } from "@bunaway/plugin";
import { osOperations } from "./operations.ts";
import { dispose, initialize } from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "os",
  platforms: {
    windows: {
      initialize,
      dispose,
      operations: osOperations,
    },
  },
});
/** Optional Windows metadata plugin. Each read requires its own operation permission. */
export const osPlugin = plugin.definition;
export default osPlugin;
/** Read OS and bundled Bun metadata. Architecture describes the running process. */
export const os = plugin.api;
export type { OSInfo, OSLocale, OSUsage } from "./contract.ts";
