import { defineNativePlugin } from "@bunaway/plugin";
import { createOpener } from "./calls.ts";
import { openerOperations } from "./contract.ts";
import { createOperations as createWindowsOperations } from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "opener",
  platforms: {
    windows: {
      execution: "io",
      create: createWindowsOperations,
    },
  },
  operations: openerOperations,
});

/** Plugin contract for validated files and HTTP and HTTPS URLs. */
export const openerPlugin = plugin.definition;
export default openerPlugin;

const calls = createOpener(plugin.api);
/** Open an absolute HTTP or HTTPS URL. Success means Explorer accepted the request. */
export const openUrl = calls.openUrl;
/** Open an existing absolute Windows file with its default app. Success is request acceptance. */
export const openFile = calls.openFile;
/** Select an existing absolute Windows file in Explorer. Success is request acceptance. */
export const revealFile = calls.revealFile;
/** Open an existing file with a selected absolute .exe application. Success is request acceptance. */
export const openFileWith = calls.openFileWith;
/** Open an HTTP or HTTPS URL with a selected absolute .exe application. Success is request acceptance. */
export const openUrlWith = calls.openUrlWith;
