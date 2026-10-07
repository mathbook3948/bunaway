import { defineApp } from "@bunaway/backend";
import { storagePlugin } from "@bunaway/plugin-storage";
import { memo } from "./memo/module.ts";

export const memoApp = defineApp({ plugins: [storagePlugin], modules: [memo] });

export default memoApp;
