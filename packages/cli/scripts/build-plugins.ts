import { resolve } from "node:path";
import { release } from "../src/distribution.ts";
import { frameworkRoot } from "../src/files.ts";
import { buildNativePlugin } from "../src/plugin-build.ts";

for (const directory of Object.keys((await release()).plugins)) {
  await buildNativePlugin(resolve(frameworkRoot, "plugins", directory));
}
