import { defineNativePlugin, type NativeInvokeOptions } from "@bunaway/plugin";
import { createLog } from "#log/logger";
import { macosOperations, windowsOperations } from "#log/operations";
import type { AppLog } from "#log/platforms/app-log";
import { initialize as initializeMacos } from "#log/platforms/macos";
import { initialize as initializeWindows } from "#log/platforms/windows";

const dispose = (log: AppLog) => {
  log.flush();
};

/** Write structured app messages through the registered host operation. */
export default defineNativePlugin(
  {
    name: "log",
    platforms: {
      macos: {
        initialize: initializeMacos,
        dispose,
        operations: macosOperations,
      },
      windows: {
        initialize: initializeWindows,
        dispose,
        operations: windowsOperations,
      },
    },
  },
  (api) => ({
    ...createLog(api.write),
    /** Update backend-owned settings with the separate log.configure permission. */
    configure: api.configure,
    /** Flush active and retained files to the OS with log.flush permission. An empty log stays absent. */
    flush: (options?: NativeInvokeOptions) => api.flush(null, options),
  }),
);

export type { LogConfiguration, LogInput } from "#log/contract";
