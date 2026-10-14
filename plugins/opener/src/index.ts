import { defineNativePlugin } from "@bunaway/plugin";
import { createOpener } from "./calls.ts";
import { macosOperations, windowsOperations } from "./operations.ts";
import {
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "./platforms/macos.ts";
import {
  dispose as disposeWindows,
  initialize as initializeWindows,
} from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "opener",
  platforms: {
    windows: {
      initialize: initializeWindows,
      dispose: disposeWindows,
      operations: windowsOperations,
    },
    macos: {
      initialize: initializeMacos,
      dispose: disposeMacos,
      operations: macosOperations,
    },
  },
});

/** Plugin contract for validated files and HTTP and HTTPS URLs. */
export const openerPlugin = plugin.definition;
export default openerPlugin;

const calls = createOpener(plugin.api);
/** Open an absolute HTTP or HTTPS URL. Success means the OS accepted the request. */
export const openUrl = calls.openUrl;
/** Open an existing absolute file with its default app on Windows or macOS. Success is request acceptance. */
export const openFile = calls.openFile;
/** Select an existing absolute file in Explorer or Finder. Success is request acceptance. */
export const revealFile = calls.revealFile;
/** Open an existing file with a selected absolute .exe application. Success is request acceptance. */
export const openFileWith = calls.openFileWith;
/** Open an HTTP or HTTPS URL with a selected absolute .exe application. Success is request acceptance. */
export const openUrlWith = calls.openUrlWith;

/** Recycle an existing Windows file. Success means the Shell reported an item in the Recycle Bin. */
export const trashFile = calls.trashFile;
