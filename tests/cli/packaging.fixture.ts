import { expect, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import * as build from "../../packages/cli/src/build.ts";
import * as files from "../../packages/cli/src/files.ts";
import { adapterFor, CODES, registerAdapter } from "../../packages/packaging/src/index.ts";

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
let nativeTarget: build.NativeInputs["target"] = "windows-x64";
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
  currentTarget: () => nativeTarget,
  buildProject: async (directory: string) => {
    builds++;
    return buildProject(directory, { native });
  },
}));
const { packageProject } = await import("../../packages/cli/src/package.ts");
await Bun.write(
  resolve(project, "packaging.json"),
  JSON.stringify({
    version: 1,
    channels: { "win-direct": {}, "win-store-msix": {}, "mac-direct": {}, "mac-store": {} },
  }),
);
nativeTarget = "macos-arm64";
await expect(packageProject(project, "mac-store", { build: true })).rejects.toThrow(
  "No adapter registered",
);
nativeTarget = "windows-x64";
expect(builds).toBe(0);

let fail = false;
let assembled = 0;
let withJunction = false;
let pause: (() => Promise<void>) | undefined;
const windowsAdapter = adapterFor("win-direct");
if (!windowsAdapter) throw new Error("Expected the built-in Windows adapter.");
spyOn(windowsAdapter, "stages").mockImplementation(() => [
  {
    id: "assemble",
    title: "Assemble installer",
    async run(ctx) {
      assembled++;
      await pause?.();
      if (fail) throw new Error("Installer assembly failed.");
      await Bun.write(resolve(ctx.staging, "setup.exe"), `installer ${builds}`);
      ctx.addArtifact("setup.exe", "installer");
      if (withJunction) {
        const payload = resolve(ctx.staging, "payload");
        await fs.mkdir(payload);
        await Bun.write(resolve(payload, "helper.exe"), "linked artifact");
        await fs.symlink(payload, resolve(ctx.staging, "linked"), "junction");
        ctx.addArtifact("linked/helper.exe", "helper");
      }
    },
  },
]);
registerAdapter({
  channel: "mac-direct",
  platform: "macos",
  signingRequirement: "optional",
  stages: () => {
    throw new Error("Wrong-platform adapter must not be resolved.");
  },
});
for (const buildFirst of [false, true]) {
  await expect(packageProject(project, "mac-direct", { build: buildFirst })).rejects.toThrow(
    "Channel mac-direct requires macos; the native host target is windows-x64",
  );
  nativeTarget = "macos-arm64";
  await expect(packageProject(project, "win-direct", { build: buildFirst })).rejects.toThrow(
    "Channel win-direct requires windows; the native host target is macos-arm64",
  );
  nativeTarget = "windows-x64";
}
expect(builds).toBe(0);
expect(assembled).toBe(0);
await Bun.write(
  resolve(project, "packaging.json"),
  JSON.stringify({
    version: 1,
    targets: [{ platform: "macos", arch: "arm64" }],
    channels: { "win-direct": {} },
  }),
);
await expect(packageProject(project, "win-direct", { build: true })).rejects.toThrow(
  "no windows target declared",
);
expect(builds).toBe(0);
await Bun.write(
  resolve(project, "packaging.json"),
  JSON.stringify({ version: 1, channels: { "win-direct": {}, "win-store-msix": {} } }),
);
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

const lockPath = resolve(packaged, "win-direct.lock");
const reportPath = resolve(packaged, "win-direct-report.json");
const savedReport = await Bun.file(reportPath).text();
const savedAssemblies = assembled;
await Bun.write(lockPath, "active package run");
const lines: string[] = [];
const logging = spyOn(console, "log").mockImplementation((message) => {
  lines.push(String(message));
});
try {
  const blocked = await packageProject(project, "win-direct");
  expect(blocked.ok).toBe(false);
  expect(blocked.diagnostics.some((d) => d.code === CODES.LOCK_FAILED)).toBe(true);
  expect(lines.some((line) => line.startsWith("Report:"))).toBe(false);
  expect(lines.some((line) => line.includes("no report was published"))).toBe(true);
  expect(assembled).toBe(savedAssemblies);
  expect(await Bun.file(reportPath).text()).toBe(savedReport);
  expect(await Bun.file(previous).text()).toBe("installer 3");
} finally {
  logging.mockRestore();
  await rm(lockPath);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// A live package reader prevents the build from moving or replacing its target.
const entered = deferred();
const resume = deferred();
pause = async () => {
  entered.resolve();
  await resume.promise;
};
const activePackage = packageProject(project, "win-direct");
try {
  await entered.promise;
  await expect(buildProject(project, { native })).rejects.toThrow("in use by packaging");
  expect(await Bun.file(previous).text()).toBe("installer 3");
  expect(await Bun.file(reportPath).text()).toBe(savedReport);
} finally {
  pause = undefined;
  resume.resolve();
  await activePackage;
}
expect((await activePackage).ok).toBe(true);
const publishedReport = await Bun.file(reportPath).text();

// A build paused after its preservation move rejects new packaging, without publishing a report.
const transferred = deferred();
const publish = deferred();
const originalRename = fs.rename;
let stagedReportPath = "";
const preservation = spyOn(fs, "rename").mockImplementation(async (...args) => {
  await originalRename(...args);
  if (String(args[0]) === resolve(packaged, "win-direct")) {
    stagedReportPath = resolve(String(args[1]), "..", "win-direct-report.json");
    transferred.resolve();
    await publish.promise;
  }
});
const activeBuild = buildProject(project, { native });
try {
  await transferred.promise;
  const rejected = await packageProject(project, "win-direct");
  expect(rejected.ok).toBe(false);
  expect(rejected.diagnostics.some((d) => d.code === CODES.LOCK_FAILED)).toBe(true);
  // readdir order differs across filesystems: the old report may already
  // have moved into staging while the exclusive build lock is held.
  const report = (await Bun.file(reportPath).exists()) ? reportPath : stagedReportPath;
  expect(await Bun.file(report).text()).toBe(publishedReport);
} finally {
  publish.resolve();
  await activeBuild;
  preservation.mockRestore();
}
expect(await Bun.file(reportPath).text()).toBe(publishedReport);

// Stale transient entries are not propagated into a fresh build.
await Bun.write(resolve(packaged, "win-direct.lock"), "stale lock");
await Bun.write(resolve(packaged, "win-direct.building-stale/setup.exe"), "unfinished");
await Bun.write(resolve(packaged, "win-direct.previous-stale/setup.exe"), "backup");
await Bun.write(resolve(packaged, "win-direct-report.json.building-stale"), "unfinished report");
await buildProject(project, { native });
expect(await Bun.file(reportPath).text()).toBe(publishedReport);
expect(await Bun.file(other).text()).toBe("another channel");
expect(await Bun.file(otherReport).text()).toBe("another report");
expect((await readdir(packaged)).some((name) => /\.lock|\.building-|\.previous-/.test(name))).toBe(
  false,
);
expect((await packageProject(project, "win-direct")).ok).toBe(true);
expect(await readdir(resolve(project, "dist/.bunaway-locks/windows-x64"))).toEqual([]);

// An accepted internal junction survives rebuilds without symlink creation privileges.
withJunction = true;
const linkedReport = await packageProject(project, "win-direct");
expect(linkedReport.ok).toBe(true);
const link = resolve(packaged, "win-direct/linked");
const helper = resolve(packaged, "win-direct/payload/helper.exe");
const originalLink = await fs.readlink(link);
const linkedReportText = await Bun.file(reportPath).text();
await buildProject(project, { native });
expect(await fs.readlink(link)).toBe(originalLink);
expect(await Bun.file(helper).text()).toBe("linked artifact");
expect(await Bun.file(reportPath).text()).toBe(linkedReportText);
expect(await Bun.file(other).text()).toBe("another channel");

// Each failure boundary restores moved artifacts, junctions and reports to the old build.
for (const failure of ["preservation", "backup", "publication"]) {
  let transfers = 0;
  const publication = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    const from = String(source);
    const to = String(destination);
    if (
      (failure === "preservation" && from.startsWith(packaged) && ++transfers === 2) ||
      (failure === "backup" && from === resolve(project, "dist/windows-x64")) ||
      (failure === "publication" &&
        from.includes("windows-x64.building-") &&
        to === resolve(project, "dist/windows-x64"))
    ) {
      throw new Error(`Build ${failure} failed.`);
    }
    await originalRename(source, destination);
  });
  try {
    await expect(buildProject(project, { native })).rejects.toThrow(`Build ${failure} failed.`);
  } finally {
    publication.mockRestore();
  }
  expect(await fs.readlink(link)).toBe(originalLink);
  expect(await Bun.file(helper).text()).toBe("linked artifact");
  expect(await Bun.file(reportPath).text()).toBe(linkedReportText);
  expect(await Bun.file(other).text()).toBe("another channel");
  expect(await Bun.file(otherReport).text()).toBe("another report");
  expect(
    (await readdir(resolve(project, "dist"))).some((name) => /\.building-|\.previous-/.test(name)),
  ).toBe(false);
  expect(await readdir(resolve(project, "dist/.bunaway-locks/windows-x64"))).toEqual([]);
}
