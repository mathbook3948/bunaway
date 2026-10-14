import { defineApp } from "@bunaway/backend";
import storage from "@bunaway/plugin-storage";
import { memo } from "./memo/module.ts";

/** Registers the memo module and the storage plugin its file operations use. */
export const memoApp = defineApp({
  plugins: [
    storage,
  ],
  modules: [
    memo,
  ],
});

export default memoApp;
