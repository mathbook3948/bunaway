import type { NativeInvokeOptions, NativePluginAPI } from "@bunaway/plugin";
import type { windowDefinitions } from "./contract.ts";

/** Add argument-free window lookup helpers to the typed operations. */
export function createWindows(api: NativePluginAPI<typeof windowDefinitions>) {
  return Object.freeze({
    ...api,
    getMonitorSnapshot: (options?: NativeInvokeOptions) =>
      api.getMonitorSnapshot(null, options),
    getMonitors: (options?: NativeInvokeOptions) =>
      api.getMonitors(null, options),
    getPrimaryMonitor: (options?: NativeInvokeOptions) =>
      api.getPrimaryMonitor(null, options),
    getCursorPosition: (options?: NativeInvokeOptions) =>
      api.getCursorPosition(null, options),
    listInstances: (options?: NativeInvokeOptions) =>
      api.listInstances(null, options),
    list: (options?: NativeInvokeOptions) => api.list(null, options),
    getCurrent: (options?: NativeInvokeOptions) =>
      api.getCurrent(null, options),
    getFocused: (options?: NativeInvokeOptions) =>
      api.getFocused(null, options),
    getLastActive: (options?: NativeInvokeOptions) =>
      api.getLastActive(null, options),
  });
}
