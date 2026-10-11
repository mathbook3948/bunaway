import { defineNativePlugin } from "@bunaway/plugin";
import { logOperations } from "./contract.ts";
import { createLog } from "./logger.ts";
import { createOperations as createWindowsOperations } from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "log",
  platforms: {
    windows: {
      execution: "io",
      create: createWindowsOperations,
    },
  },
  operations: logOperations,
});
/** Plugin contract for app log writes. */
export const logPlugin = plugin.definition;
export default logPlugin;

/** Write structured app messages through the registered host operation. */
export const log = createLog(plugin.api.write);
export type { LogInput } from "./contract.ts";
