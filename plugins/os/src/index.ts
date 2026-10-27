import { defineNativePlugin } from "@bunaway/plugin";
import { osOperations } from "#os/operations";
import {
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "#os/platforms/macos";
import { dispose, initialize } from "#os/platforms/windows";
/**
 * Read OS and bundled Bun metadata, play system sounds, and list printers, graphics adapters and the app's process tree, and read the camera and microphone privacy settings on Windows.
 * Architecture describes the running process. Printer reads block on the Windows print spooler
 * and cannot be cancelled once started.
 */
export default defineNativePlugin({
  name: "os",
  platforms: {
    macos: {
      initialize: initializeMacos,
      dispose: disposeMacos,
      operations: osOperations,
    },
    windows: {
      initialize,
      dispose,
      operations: osOperations,
    },
  },
});

export type {
  OSAppProcess,
  OSBeepInput,
  OSGpu,
  OSInfo,
  OSLocale,
  OSMediaAccessInput,
  OSMediaAccessStatus,
  OSMediaType,
  OSPrinter,
  OSUsage,
} from "#os/contract";
