import { dlopen, type Pointer, ptr, read, toArrayBuffer } from "bun:ffi";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AppDefinition } from "../../../packages/core/src/index.ts";
import { type HostContext, parsePolicy } from "../../../packages/protocol/src/index.ts";
import pin from "../../../runtime/build-manifests/windows-x64.json";
import { readWindowSpecs } from "../../../packages/runtime-bun/src/window-config.ts";
import type { UIConfig } from "./channel.ts";
import deps from "./deps.json";
import { runWindowsApp } from "./entry.ts";
import { AppAlreadyRunningError, containAppProcess } from "./job.ts";
import {
  forwardToInstance,
  instanceAddress,
  listenForInstances,
  parseLaunchArguments,
  readLaunchArguments,
  type LaunchArguments,
} from "./instance.ts";
import {
  verifyDevelopmentLaunch,
  verifyDevelopmentToolsLaunch,
} from "../../../packages/runtime-bun/src/development.ts";

const hash = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
function object(value: unknown): Record<string, unknown> {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    "Invalid package configuration",
  );
  return value as Record<string, unknown>;
}
function localAppData() {
  const shell = dlopen("shell32.dll", {
    SHGetKnownFolderPath: { args: ["ptr", "u32", "u64", "ptr"], returns: "i32" },
  });
  const ole = dlopen("ole32.dll", { CoTaskMemFree: { args: ["ptr"], returns: "void" } });
  const out = new BigUint64Array(1);
  try {
    const guid = Buffer.from("8527b3f1ba6fcf4f9d557b8e7f157091", "hex");
    assert.equal(shell.symbols.SHGetKnownFolderPath(ptr(guid), 0, 0n, ptr(out)), 0);
    const address = Number(out[0]) as Pointer;
    assert(address);
    let length = 0;
    while (length < 65536 && read.u16(address, length)) length += 2;
    assert(length < 65536);
    return Buffer.from(toArrayBuffer(address, 0, length)).toString("utf16le");
  } finally {
    if (out[0]) ole.symbols.CoTaskMemFree(Number(out[0]) as Pointer);
    shell.close();
    ole.close();
  }
}

export async function verifyWindowsPackage(
  directory: string,
  developmentUrl?: string,
  developmentTools = false,
): Promise<UIConfig> {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  assert.equal(Bun.version, pin.bun.version);
  assert.equal(Bun.revision, pin.bun.sourceRevision);
  for (const name of Object.keys(process.env))
    assert(!/^(BUN_|NODE_OPTIONS$|WEBVIEW2_)/i.test(name), `Unsafe launch environment: ${name}`);
  const root = await realpath(resolve(directory));
  const manifest = object(JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8")));
  const bun = object(manifest.bun);
  assert.equal(bun.executableSha256, pin.bun.executableSha256);
  assert.equal(bun.sourceRevision, pin.bun.sourceRevision);
  const packagedBunSha = bun.packagedSha256 ?? pin.bun.executableSha256;
  assert(
    typeof packagedBunSha === "string" && /^[a-f0-9]{64}$/.test(packagedBunSha),
    "Invalid packaged Bun hash",
  );
  assert.equal(await hash(resolve(root, "runtime/bun.exe")), packagedBunSha, "Bun hash mismatch");
  assert.equal(
    await realpath(process.execPath),
    await realpath(resolve(root, "runtime/bun.exe")),
    "Use the package's absolute bundled Bun",
  );
  const assets = object(manifest.assets);
  const actual: string[] = [];
  async function visit(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = resolve(path, entry.name);
      const info = await lstat(target);
      assert(!info.isSymbolicLink(), "Package links are not allowed");
      if (info.isDirectory()) await visit(target);
      else {
        assert(info.isFile());
        actual.push(relative(root, target).replaceAll("\\", "/"));
      }
    }
  }
  await visit(resolve(root, "assets"));
  await visit(resolve(root, "licenses"));
  assert.deepEqual(actual.sort(), Object.keys(assets).sort(), "Package inventory mismatch");
  for (const [name, expected] of Object.entries(assets)) {
    assert(typeof expected === "string" && /^[a-f0-9]{64}$/.test(expected));
    assert(!isAbsolute(name) && !name.includes("\\") && !name.split("/").includes(".."));
    assert.equal(await hash(resolve(root, name)), expected, `Asset hash mismatch: ${name}`);
  }
  assert.equal(
    await hash(resolve(root, "assets/WebView2Loader.dll")),
    deps.webview2Sdk.files["build/native/x64/WebView2Loader.dll"],
  );
  for (const name of [
    "assets/boot.js",
    "assets/ui.js",
    "assets/host-operations.js",
    "assets/app.js",
    "assets/WebView2Loader.dll",
    "assets/app.json",
    "assets/policy.json",
    "assets/bunfig.toml",
    "assets/tsconfig.json",
  ])
    assert(Object.hasOwn(assets, name), `Required package asset missing: ${name}`);
  const config = object(JSON.parse(await readFile(resolve(root, "assets/app.json"), "utf8")));
  const devUrl = verifyDevelopmentLaunch(config.development, developmentUrl);
  const devtools = verifyDevelopmentToolsLaunch(config.developmentTools, developmentTools);
  assert(
    typeof config.appId === "string" &&
      /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(config.appId),
    "Invalid app id",
  );
  const policy = parsePolicy(await readFile(resolve(root, "assets/policy.json"), "utf8"));
  const specs = config.windows ?? [
    { view: config.view, home: config.home, title: config.title, window: config.window },
  ];
  const windows = readWindowSpecs(specs, policy, devUrl);
  return {
    runtime: { id: config.appId, generation: crypto.randomUUID() },
    backendContext: `backend-${crypto.randomUUID()}` as HostContext,
    policy,
    windows,
    assets: resolve(root, "assets"),
    loader: resolve(root, "assets/WebView2Loader.dll"),
    legacyProfile: !Array.isArray(config.windows),
    devtools,
    dataRoot: resolve(localAppData(), "bunaway", config.appId),
  };
}

if (import.meta.main) {
  const root = resolve(dirname(import.meta.path), "..");
  const args = process.argv.slice(2);
  const devtools = args[0] === "--devtools";
  if (devtools) args.shift();
  const developmentUrl = args[0] === "--dev-url" ? args[1] : undefined;
  if (args[0] === "--dev-url") assert(developmentUrl, "Missing development URL");
  const config = await verifyWindowsPackage(root, developmentUrl, devtools);
  // Launchers send JSON on stdin to preserve arguments without expanding the command line.
  let launch: LaunchArguments;
  const appArgs = developmentUrl ? args.slice(2) : args;
  if (appArgs[0] === "--launch-stdin") {
    assert(appArgs.length === 1, "Invalid launch input");
    launch = await readLaunchArguments(Bun.stdin.stream());
  } else launch = parseLaunchArguments({ argv: appArgs, cwd: process.cwd() });
  try {
    containAppProcess(config.dataRoot);
  } catch (error) {
    if (!(error instanceof AppAlreadyRunningError)) throw error;
    await forwardToInstance(instanceAddress(config.dataRoot), launch);
    process.exit(0);
  }
  const inbox = await listenForInstances(instanceAddress(config.dataRoot));
  try {
    // Only the owner imports the app after all package checks and IPC readiness.
    const module = await import(pathToFileURL(resolve(root, "assets/app.js")).href);
    const app = object(module.default);
    assert(app.commands && app.events, "App must default-export an AppDefinition");
    await runWindowsApp(app as AppDefinition, config, launch, inbox);
  } finally {
    // runWindowsApp also closes on shutdown; early import failures need this path.
    await inbox.close().catch(() => {});
  }
  process.exit(0);
}
