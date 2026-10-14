import { defineNativePlugin, type NativeEnvironment } from "@bunaway/plugin";
import { createLog } from "./logger.ts";
import { macosOperations, windowsOperations } from "./operations.ts";

const dataRoot = (environment: NativeEnvironment) => environment.dataRoot;

/** Write structured app messages through the registered host operation. */
export default defineNativePlugin(
  {
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
  },
  (api) => createLog(api.write),
);

export type { LogInput } from "./contract.ts";
