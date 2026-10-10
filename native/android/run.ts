import { cp, mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { appModules } from "#cli/app-modules";
import { assembleAndroidApk } from "#cli/android";
import { frameworkRoot, writeJson } from "#cli/files";
import { run } from "#cli/processes";
import { parsePolicy } from "@bunaway/protocol";

const inputs = resolve(frameworkRoot, "build/android-host");
const fixture = resolve(frameworkRoot, "tests/fixtures/android");
const assets = resolve(inputs, "assets/bunaway");
await mkdir(resolve(assets, "web"), {
  recursive: true,
});
const project = {
  app: {
    appId: "dev.bunaway.fixture",
    title: 'Bunaway "Android" & WebView',
    view: "main",
    home: "https://APP.BUNAWAY.LOCAL/",
    window: {
      width: 800,
      height: 600,
    },
  },
  policy: parsePolicy(await Bun.file(resolve(fixture, "policy.json")).text()),
};
const backend = await Bun.build({
  entrypoints: [
    "bunaway-generated/backend.ts",
  ],
  root: frameworkRoot,
  target: "bun",
  packages: "bundle",
  plugins: [
    appModules({
      appEntry: resolve(fixture, "app.ts"),
      processRuntime: resolve(
        frameworkRoot,
        "packages/runtime-bun/src/index.ts",
      ),
    }),
  ],
});
const backendOutput = backend.outputs[0];
if (!backend.success || backend.outputs.length !== 1 || !backendOutput) {
  throw new Error(`Android backend bundle failed: ${backend.logs.join("\n")}`);
}
await Bun.write(resolve(assets, "backend.js"), backendOutput);
const frontend = await Bun.build({
  entrypoints: [
    resolve(fixture, "web/client.ts"),
    resolve(fixture, "web/frame.ts"),
  ],
  target: "browser",
  packages: "bundle",
});
if (!frontend.success || frontend.outputs.length !== 2) {
  throw new Error(
    `Android frontend bundle failed: ${frontend.logs.join("\n")}`,
  );
}
for (const output of frontend.outputs) {
  await Bun.write(resolve(assets, "web", basename(output.path)), output);
}
for (const name of [
  "index.html",
  "frame.html",
]) {
  await cp(resolve(fixture, "web", name), resolve(assets, "web", name));
}
const apk = await assembleAndroidApk(project, inputs);
await writeJson(resolve(inputs, "build.json"), {
  apk,
  appId: project.app.appId,
});
await run(
  [
    process.execPath,
    resolve(frameworkRoot, "tests/lifecycle/android-host.ts"),
    inputs,
  ],
  frameworkRoot,
);
