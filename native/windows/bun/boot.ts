import { dlopen, type Pointer, ptr, read, toArrayBuffer } from "bun:ffi";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AppDefinition } from "../../../packages/core/src/index.ts";
import { type HostContext, parsePolicy } from "../../../packages/protocol/src/index.ts";
import pin from "../../../runtime/build-manifests/windows-x64.json";
import { MAX_WINDOWS, type UIConfig, type WindowSpec } from "./channel.ts";
import deps from "./deps.json";
import { runWindowsApp } from "./entry.ts";
import { containAppProcess } from "./job.ts";

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

export async function verifyWindowsPackage(directory: string): Promise<UIConfig> {
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
  assert(
    typeof config.appId === "string" &&
      /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(config.appId),
    "Invalid app id",
  );
  const policy = parsePolicy(await readFile(resolve(root, "assets/policy.json"), "utf8"));
  const specs = config.windows ?? [
    { view: config.view, home: config.home, title: config.title, window: config.window },
  ];
  assert(
    Array.isArray(specs) && specs.length > 0 && specs.length <= MAX_WINDOWS,
    "Invalid windows",
  );
  const windows: WindowSpec[] = specs.map((value) => {
    const spec = object(value);
    const size = object(spec.window);
    assert(typeof spec.view === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(spec.view));
    assert(typeof spec.title === "string" && spec.title.length > 0 && spec.title.length <= 1024);
    assert(typeof spec.home === "string");
    const url = new URL(spec.home);
    assert.equal(url.origin, "https://app.bunaway.local");
    assert(!url.username && !url.password && !url.hash);
    assert(policy.views.find((view) => view.id === spec.view)?.origins.includes(url.origin));
    for (const dimension of [size.width, size.height])
      assert(
        typeof dimension === "number" &&
          Number.isInteger(dimension) &&
          dimension >= 200 &&
          dimension <= 4096,
      );
    return {
      view: spec.view,
      home: spec.home,
      title: spec.title,
      window: { width: Number(size.width), height: Number(size.height) },
    };
  });
  assert.equal(new Set(windows.map((spec) => spec.view)).size, windows.length);
  return {
    runtime: { id: config.appId, generation: crypto.randomUUID() },
    backendContext: `backend-${crypto.randomUUID()}` as HostContext,
    policy,
    windows,
    assets: resolve(root, "assets"),
    loader: resolve(root, "assets/WebView2Loader.dll"),
    legacyProfile: !Array.isArray(config.windows),
    dataRoot: resolve(localAppData(), "bunaway", config.appId),
  };
}

if (import.meta.main) {
  const root = resolve(dirname(import.meta.path), "..");
  const config = await verifyWindowsPackage(root);
  containAppProcess(config.dataRoot);
  // Only import a side-effect-free default AppDefinition after all package checks.
  const module = await import(pathToFileURL(resolve(root, "assets/app.js")).href);
  const app = object(module.default);
  assert(app.commands && app.events, "windowsApp must default-export an AppDefinition");
  await runWindowsApp(app as AppDefinition, config);
  process.exit(0);
}
