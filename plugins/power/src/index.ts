import { defineNativePlugin, type NativeInvokeOptions } from "@bunaway/plugin";
import { powerOperations } from "./operations.ts";
import { dispose, initialize } from "./platforms/windows.ts";

/** Each operation needs its own grant. Repeated starts allocate independently stoppable requests. */
export default defineNativePlugin(
  {
    name: "power",
    platforms: {
      windows: {
        initialize,
        dispose,
        operations: powerOperations,
      },
    },
  },
  (api) => ({
    ...api,
    getStatus: (options?: NativeInvokeOptions) => api.getStatus(null, options),
    getIdleTime: (options?: NativeInvokeOptions) =>
      api.getIdleTime(null, options),
    listBlockers: (options?: NativeInvokeOptions) =>
      api.listBlockers(null, options),
  }),
);

export type {
  PowerBlocker,
  PowerBlockerType,
  PowerStatus,
} from "./contract.ts";
