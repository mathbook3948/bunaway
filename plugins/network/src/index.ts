import { defineNativePlugin, type NativeInvokeOptions } from "@bunaway/plugin";
import { networkEvents } from "#network/contract";
import { macosOperations, windowsOperations } from "#network/operations";
import {
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "#network/platforms/macos";
import {
  dispose as disposeWindows,
  initialize as initializeWindows,
} from "#network/platforms/windows";
/**
 * Bounded HTTP requests and WebSocket exchanges. Cancellation releases in-flight resources.
 * `network.isOnline` reports whether a non-loopback connection exists on Windows and macOS;
 * `network.onlineChanged` reports changes of that value on Windows and macOS. `network.resolveHost` returns
 * the addresses the system resolver gives for a host name. `network.resolveProxy` returns the
 * proxies the Windows system settings select for a URL, or a direct connection.
 * `network.download` saves a response body to a file the app already checked, `network.downloadStatus`
 * reports its progress to the source that started it and `network.cancelDownload` stops it.
 */
export default defineNativePlugin(
  {
    name: "network",
    events: networkEvents,
    platforms: {
      macos: {
        thread: "ui",
        initialize: initializeMacos,
        dispose: disposeMacos,
        operations: macosOperations,
      },
      windows: {
        thread: "ui",
        initialize: initializeWindows,
        dispose: disposeWindows,
        operations: windowsOperations,
      },
    },
  },
  (api) => ({
    ...api,
    isOnline: (options?: NativeInvokeOptions) => api.isOnline(null, options),
  }),
);

export type { NetworkRequest, NetworkResponse } from "#network/contract";
