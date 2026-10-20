import { defineNativePlugin } from "@bunaway/plugin";
import { osOperations } from "#os/operations";
import {
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "#os/platforms/macos";
import { dispose, initialize } from "#os/platforms/windows";
/**
 * Read OS and bundled Bun metadata, play system sounds, and list printers and graphics adapters on Windows.
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
  OSBeepInput,
  OSGpu,
  OSInfo,
  OSLocale,
  OSPrinter,
  OSUsage,
} from "#os/contract";
