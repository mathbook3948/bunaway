import { defineNativePlugin, type NativeInvokeOptions } from "@bunaway/plugin";
import { powerEvents } from "#power/contract";
import { powerOperations } from "#power/operations";
import { dispose, initialize } from "#power/platforms/windows";
/** Each operation needs its own grant. Repeated starts allocate independently stoppable requests. `power.statusChanged` reports AC and battery changes on the UI thread. */
export default defineNativePlugin(
  {
    name: "power",
    events: powerEvents,
    platforms: {
      windows: {
        thread: "ui",
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
} from "#power/contract";
