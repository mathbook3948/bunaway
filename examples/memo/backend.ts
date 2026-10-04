import { runBunApp } from "../../packages/runtime-bun/src/index.ts";
import { memoApp } from "./app.ts";

await runBunApp(memoApp);
