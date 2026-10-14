import { defineNativePlugin, type NativeEnvironment } from "@bunaway/plugin";
import { createLog } from "./logger.ts";
import { macosOperations, windowsOperations } from "./operations.ts";

const dataRoot = (environment: NativeEnvironment) => environment.dataRoot;

const plugin = defineNativePlugin({
  name: "log",
  platforms: {
    macos: {
      initialize: dataRoot,
      operations: macosOperations,
    },
    windows: {
      initialize: dataRoot,
      operations: windowsOperations,
    },
  },
});
/** Plugin contract for app log writes. */
export const logPlugin = plugin.definition;
export default logPlugin;

/** Write structured app messages through the registered host operation. */
export const log = createLog(plugin.api.write);
export type { LogInput } from "./contract.ts";
