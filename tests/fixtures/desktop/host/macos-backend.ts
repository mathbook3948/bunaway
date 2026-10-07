import { runBunApp } from "../../../../packages/runtime-bun/src/index.ts";
import { macosApp } from "./macos-app.ts";

await runBunApp(macosApp);
