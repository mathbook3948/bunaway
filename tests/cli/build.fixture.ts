// Run the real CLI and frontend processes with fixture native inputs. OS host
// behavior and installer tooling are covered by platform integration runners.
import { mock, spyOn } from "bun:test";
import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as build from "../../packages/cli/src/build.ts";
import * as files from "../../packages/cli/src/files.ts";
import { adapterFor } from "../../packages/packaging/src/index.ts";

const project = process.argv[2];
if (!project) throw new Error("Expected a generated project path.");
const nativeDir = resolve(project, ".bunaway/test-native");
const loader = resolve(nativeDir, "WebView2Loader.dll");
const native: build.NativeInputs = {
  target: "windows-x64",
  host: resolve(nativeDir, "bun.exe"),
  bun: resolve(nativeDir, "bun.exe"),
  loader,
  licenses: {
    "LICENSE.bun": resolve(nativeDir, "LICENSE.bun"),
    "License-WebView2.txt": resolve(nativeDir, "License-WebView2.txt"),
  },
};
await Bun.write(native.bun, "fixture native input");
await Bun.write(loader, "fixture loader input");
for (const [name, path] of Object.entries(native.licenses)) {
  await copyFile(resolve(files.frameworkRoot, "licenses", name), path);
}
const readJson = files.json;
mock.module(import.meta.resolve("../../packages/cli/src/files.ts"), () => ({
  ...files,
  json: async (path: string) => {
    const value = await readJson(path);
    const normalized = path.replaceAll("\\", "/");
    if (normalized.endsWith("runtime/build-manifests/windows-x64.json")) {
      const pin = value as { bun: Record<string, unknown> };
      return {
        ...(value as object),
        bun: {
          ...pin.bun,
          version: Bun.version,
          executableSha256: await files.hash(native.bun),
          licenseSha256: await files.hash(native.licenses["LICENSE.bun"] ?? ""),
        },
      };
    }
    if (normalized.endsWith("native/windows/bun/deps.json")) {
      return {
        webview2Sdk: {
          files: {
            "LICENSE.txt": await files.hash(native.licenses["License-WebView2.txt"] ?? ""),
            "build/native/x64/WebView2Loader.dll": await files.hash(loader),
          },
        },
      };
    }
    return value;
  },
}));
const buildProject = build.buildProject;
mock.module(import.meta.resolve("../../packages/cli/src/build.ts"), () => ({
  ...build,
  currentTarget: () => "windows-x64",
  buildProject: (directory: string) => buildProject(directory, { native }),
}));
const adapter = adapterFor("win-direct");
if (!adapter) throw new Error("Missing Windows packaging adapter.");
spyOn(adapter, "stages").mockImplementation(() => [
  {
    id: "assemble",
    title: "Assemble fixture installer",
    async run(ctx) {
      await Bun.write(resolve(ctx.staging, "setup.exe"), "fixture installer");
      ctx.addArtifact("setup.exe", "installer");
    },
  },
]);
const { main } = await import("../../packages/cli/src/main.ts");
process.exitCode = await main([
  ...(process.argv.slice(3).length ? process.argv.slice(3) : ["build"]),
  project,
]);
