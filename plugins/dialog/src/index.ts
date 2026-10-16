import { defineNativePlugin } from "@bunaway/plugin";
import { dialogOperations } from "#dialog/operations";
import { busy, dispose, initialize } from "#dialog/platforms/windows";
/** Select filesystem paths and show message or confirmation dialogs, each behind its own grant. Windows only. */
export default defineNativePlugin({
  name: "dialog",
  platforms: {
    windows: {
      thread: "ui",
      initialize,
      dispose,
      busy,
      operations: dialogOperations,
    },
  },
});
