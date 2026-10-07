import { defineApp } from "@bunaway/backend";
import { storagePlugin } from "@bunaway/plugin-storage";
import { message } from "./message/module.ts";

export const app = defineApp({
  plugins: [
    storagePlugin,
  ],
  modules: [
    message,
  ],
});

export default app;
