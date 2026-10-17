import { runBunApp } from "@bunaway/runtime-bun";
import { testAppMetadata } from "../../app-info.ts";
import { macosApp } from "./macos-app.ts";

await runBunApp(macosApp, {
  app: testAppMetadata,
});
