import { defineApp } from "@bunaway/backend";
import { memo } from "./memo/module.ts";

export const memoApp = defineApp({ modules: [memo] });

export default memoApp;
