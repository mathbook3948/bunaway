import { defineApp } from "@bunaway/backend";
import { storagePlugin } from "@bunaway/plugin-storage";
import { message } from "./message/module.ts";

/** Registers storage for the message module's appData operations. */
export const app = defineApp({
  plugins: [
    storagePlugin,
  ],
  modules: [
    message,
  ],
});

export default app;
