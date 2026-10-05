import { expect, mock } from "bun:test";
import { resolve } from "node:path";
import * as build from "../../packages/cli/src/build.ts";
import * as files from "../../packages/cli/src/files.ts";
import { registerAdapter } from "../../packages/packaging/src/index.ts";

const project = process.argv[2];
if (!project) throw new Error("Expected a generated project path.");
const nativeDir = resolve(project, ".bunaway/test-native");
const native: build.NativeInputs = {
  target: "windows-x64",
  host: resolve(nativeDir, "host.exe"),
  bun: resolve(nativeDir, "bun.exe"),
  licenses: {
    "LICENSE.bun": resolve(nativeDir, "LICENSE.bun"),
    "LICENSE.nlohmann-json": resolve(nativeDir, "LICENSE.nlohmann-json"),
    "License-WebView2.txt": resolve(nativeDir, "License-WebView2.txt"),
  },
};
for (const path of [native.host, native.bun, ...Object.values(native.licenses)]) {
  await Bun.write(path, "test native input");
}

// Isolate native inputs and their pins while exercising real build/package code.
const buildProject = build.buildProject;
const readJson = files.json;
const pinPath = resolve(files.frameworkRoot, "runtime/build-manifests/windows-x64.json");
const depsPath = resolve(files.frameworkRoot, "native/windows/host/deps.json");
let builds = 0;
mock.module(import.meta.resolve("../../packages/cli/src/files.ts"), () => ({
  ...files,
  json: async (path: string) => {
    const value = await readJson(path);
    if (path === pinPath) {
      const pin = value as { bun: Record<string, unknown>; json: Record<string, unknown> };
      return {
        ...pin,
        bun: {
          ...pin.bun,
          executableSha256: await files.hash(native.bun),
          licenseSha256: await files.hash(native.licenses["LICENSE.bun"] ?? ""),
        },
        json: {
          ...pin.json,
          licenseSha256: await files.hash(native.licenses["LICENSE.nlohmann-json"] ?? ""),
        },
      };
    }
    if (path === depsPath) {
      return {
        webview2Sdk: {
          files: { "LICENSE.txt": await files.hash(native.licenses["License-WebView2.txt"] ?? "") },
        },
      };
    }
    return value;
  },
}));
mock.module(import.meta.resolve("../../packages/cli/src/build.ts"), () => ({
  ...build,
  currentTarget: () => "windows-x64",
  buildProject: async (directory: string) => {
    builds++;
    return buildProject(directory, { native });
  },
}));
const { packageProject } = await import("../../packages/cli/src/package.ts");
await Bun.write(
  resolve(project, "packaging.json"),
  JSON.stringify({ version: 1, channels: { "win-direct": {}, "win-store-msix": {} } }),
);
await expect(packageProject(project, "win-store-msix", { build: true })).rejects.toThrow(
  "No adapter registered",
);
expect(builds).toBe(0);

let fail = false;
let assembled = 0;
registerAdapter({
  channel: "win-direct",
  platform: "windows",
  signingRequirement: "optional",
  stages: () => [
    {
      id: "assemble",
      title: "Assemble installer",
      async run(ctx) {
        assembled++;
        if (fail) throw new Error("Installer assembly failed.");
        await Bun.write(resolve(ctx.staging, "setup.exe"), `installer ${builds}`);
        ctx.addArtifact("setup.exe", "installer");
      },
    },
  ],
});
expect((await packageProject(project, "win-direct", { build: true })).ok).toBe(true);
const packaged = resolve(project, "dist/windows-x64/packaged");
const previous = resolve(packaged, "win-direct/setup.exe");
const other = resolve(packaged, "win-store-msix/app.msix");
const otherReport = resolve(packaged, "win-store-msix-report.json");
await Bun.write(other, "another channel");
await Bun.write(otherReport, "another report");
fail = true;
expect((await packageProject(project, "win-direct", { build: true })).ok).toBe(false);
expect(await Bun.file(previous).text()).toBe("installer 1");
expect(await Bun.file(other).text()).toBe("another channel");
expect(await Bun.file(otherReport).text()).toBe("another report");
const appPath = resolve(project, "app.json");
const originalApp = (await readJson(appPath)) as Record<string, unknown>;
await Bun.write(appPath, JSON.stringify({ ...originalApp, appId: "app.changed" }));
const previousAssemblies = assembled;
const stale = await packageProject(project, "win-direct");
expect(stale.ok).toBe(false);
expect(stale.diagnostics.some((d) => d.code === "PKG_INPUT_UNEXPECTED")).toBe(true);
expect(assembled).toBe(previousAssemblies);
expect(await Bun.file(previous).text()).toBe("installer 1");
await Bun.write(appPath, JSON.stringify(originalApp));
fail = false;
expect((await packageProject(project, "win-direct", { build: true })).ok).toBe(true);
expect(await Bun.file(previous).text()).toBe("installer 3");
expect(await Bun.file(other).text()).toBe("another channel");
expect(await Bun.file(otherReport).text()).toBe("another report");
