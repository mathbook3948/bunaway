import { defineApp } from "@bunaway/backend";
import { message } from "./message/module.ts";

export const app = defineApp({ modules: [message] });

export default app;
