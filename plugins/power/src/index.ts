import { defineNativePlugin, type NativeInvokeOptions } from "@bunaway/plugin";
import { powerEvents } from "#power/contract";
import { macosPowerOperations, powerOperations } from "#power/operations";
import {
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "#power/platforms/macos";
import {
  dispose as disposeWindows,
  initialize as initializeWindows,
} from "#power/platforms/windows";
/** Windows implements every operation; macOS implements everything except `getCpuSpeedLimit`. Each operation needs its own grant. Repeated starts allocate independently stoppable requests. `power.statusChanged` reports AC and battery changes on the UI thread. `power.suspended`, `power.resumed`, `power.sessionLocked` and `power.sessionUnlocked` report system sleep, wake and WTS session lock. */
export default defineNativePlugin(
  {
    name: "power",
    events: powerEvents,
    platforms: {
      macos: {
        thread: "ui",
        initialize: initializeMacos,
        dispose: disposeMacos,
        operations: macosPowerOperations,
      },
      windows: {
        thread: "ui",
        initialize: initializeWindows,
        dispose: disposeWindows,
        operations: powerOperations,
      },
    },
  },
  (api) => ({
    ...api,
    getStatus: (options?: NativeInvokeOptions) => api.getStatus(null, options),
    getCpuSpeedLimit: (options?: NativeInvokeOptions) =>
      api.getCpuSpeedLimit(null, options),
    getIdleTime: (options?: NativeInvokeOptions) =>
      api.getIdleTime(null, options),
    listBlockers: (options?: NativeInvokeOptions) =>
      api.listBlockers(null, options),
  }),
);

export type {
  PowerBlocker,
  PowerBlockerType,
  PowerCpuSpeedLimit,
  PowerStatus,
} from "#power/contract";
