import { defineNativePlugin } from "@bunaway/plugin";
import { dialogOperations } from "#dialog/operations";
import { busy, dispose, initialize } from "#dialog/platforms/windows";
/** Select filesystem paths without opening files or granting storage access. Windows only. */
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
