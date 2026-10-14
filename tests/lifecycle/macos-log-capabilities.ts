import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { readAppManifest } from "@bunaway/runtime-bun/app-manifest";
import { NativeRegistry, type Policy } from "@bunaway/protocol";
import { bundleMacosHost } from "#cli/assets";
import { files, hash, writeJson } from "#cli/files";
import { compileMacosApp } from "#cli/macos-compile";
import { installedPlugins } from "#cli/plugins";
import { run } from "#cli/processes";
import pin from "../../runtime/build-manifests/darwin-aarch64.json";

assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
const root = resolve(import.meta.dir, "../..");
const directory = await mkdtemp(resolve(tmpdir(), "bunaway-macos-log-host-"));
let child: ReturnType<typeof Bun.spawn> | undefined;
let dataRoot: string | undefined;
const diagnostics = resolve(root, "build/macos-log-capabilities-diagnostics");
const resultPath = resolve(root, "build/macos-log-capabilities-results.json");
try {
  const app = resolve(directory, "LogCapabilities.app");
  const packageRoot = resolve(app, "Contents/Resources");
  const assets = resolve(packageRoot, "assets");
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  const sourceDirectory = resolve(directory, "source");
  await cp(
    resolve(root, "tests/fixtures/macos-log-capabilities"),
    sourceDirectory,
    {
      recursive: true,
    },
  );
  // Resolve the copied, typechecked fixture's public dependencies without changing repository files.
  await symlink(
    resolve(root, "node_modules"),
    resolve(sourceDirectory, "node_modules"),
    "dir",
  );
  const appEntry = resolve(sourceDirectory, "app.ts");
  const source = resolve(sourceDirectory, "web.ts");
  const web = await Bun.build({
    entrypoints: [
      source,
    ],
    target: "browser",
    outdir: resolve(assets, "web"),
  });
  assert(web.success, web.logs.map(String).join("\n"));
  for (const output of web.outputs) {
    await Bun.write(output.path, await output.arrayBuffer());
  }
  for (const view of [
    "main",
    "denied",
  ]) {
    await Bun.write(
      resolve(assets, "web", `${view}.html`),
      '<!doctype html><title>Log and capabilities</title><script type="module" src="web.js"></script>',
    );
  }
  const policy: Policy = {
    version: 1,
    backend: {
      permissions: [
        "log.write",
        "capabilities.get",
      ],
    },
    views: [
      "main",
      "denied",
    ].map((id) => ({
      id,
      origins: [
        "https://app.bunaway.local",
      ],
      events: [],
      commands: [
        "test.denied",
        "test.waitDenied",
        "test.report",
        "test.writeFailure",
        "plugin.log.write",
        "plugin.capabilities.get",
        "plugin.windows.close",
        "plugin.windows.getContentSize",
      ],
      host: {
        permissions:
          id === "main"
            ? [
                "log.write",
                "capabilities.get",
                "windows.close",
                "windows.getContentSize",
              ]
            : [
                "windows.close",
              ],
      },
    })),
  };
  await writeJson(resolve(assets, "manifest.json"), {
    format: 1,
    app: {
      appId: "tests.macos.log-capabilities",
      title: "Log and capabilities",
      windows: [
        "main",
        "denied",
      ].map((view) => ({
        view,
        home: `https://app.bunaway.local/${view}.html`,
        title: view,
        window: {
          width: 400,
          height: 300,
        },
      })),
    },
    policy,
    plugins: [],
    developmentSdk: {},
  });
  const installed = await installedPlugins(root, "0.0.0");
  new NativeRegistry(installed, {
    mode: "catalog",
  }).validatePolicy(policy);
  const bundled = await bundleMacosHost(
    resolve(root, "native/macos/bun"),
    assets,
    appEntry,
    undefined,
    false,
    installed,
  );
  const executable = resolve(app, "Contents/MacOS/bunaway-host");
  await mkdir(resolve(app, "Contents/MacOS"), {
    recursive: true,
  });
  await compileMacosApp(assets, process.execPath, executable, bundled);
  const inventory: Record<string, string> = {};
  for (const file of await files(assets)) {
    inventory[relative(packageRoot, file)] = await hash(file);
  }
  await writeJson(resolve(packageRoot, "manifest.json"), {
    bun: pin.bun,
    assets: inventory,
    host: {
      kind: "bun-compiled",
      target: "macos-arm64",
    },
  });
  await Bun.write(
    resolve(app, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>bunaway-host</string>
<key>CFBundleIdentifier</key><string>tests.macos.log-capabilities</string>
<key>CFBundleName</key><string>Log capabilities fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.0.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>`,
  );
  await run(
    [
      "/usr/bin/codesign",
      "--force",
      "--sign",
      "-",
      "--entitlements",
      resolve(root, "native/macos/bun/entitlements.plist"),
      app,
    ],
    root,
  );
  await run(
    [
      "/usr/bin/codesign",
      "--verify",
      "--strict",
      app,
    ],
    root,
  );
  // The app runs without its TypeScript entries and reports the installed compiled catalog.
  await rm(sourceDirectory, {
    recursive: true,
    force: true,
  });
  dataRoot = resolve(
    directory,
    "Library/Application Support/bunaway/tests.macos.log-capabilities",
  );
  await mkdir(resolve(dataRoot, "logs"), {
    recursive: true,
  });
  await Bun.write(resolve(dataRoot, "logs/app.log.1"), "previous archive");
  const launched = Bun.spawn(
    [
      executable,
      "--package",
      packageRoot,
    ],
    {
      env: {
        ...process.env,
        HOME: directory,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    },
  );
  child = launched;
  const output = new Response(launched.stdout).text();
  const errors = new Response(launched.stderr).text();
  assert.equal(await launched.exited, 0, await errors);
  await output;
  const report = await Bun.file(resolve(dataRoot, "temp/report.json")).json();
  assert.equal(report.ok, true, JSON.stringify(report));
  const manifest = await readAppManifest(assets);
  // Installed packages do not become registered capabilities. Match the app's registration order.
  const registered = [
    "log",
    "capabilities",
    "windows",
  ].map((name) => {
    const plugin = manifest.plugins.find((plugin) => plugin.name === name);
    assert(plugin, `Missing installed plugin: ${name}.`);
    return plugin;
  });
  const expected = registered.flatMap((plugin) =>
    plugin.native.operations.map((operation) => ({
      name: operation.name,
      support:
        plugin.thread !== undefined &&
        (plugin.supportedOperations === undefined ||
          plugin.supportedOperations.includes(operation.name))
          ? "supported"
          : "unsupported",
    })),
  );
  assert.deepEqual(report.support, expected);
  assert.deepEqual(
    await Bun.file(resolve(dataRoot, "temp/setup.json")).json(),
    expected,
  );
  assert.equal((await stat(resolve(dataRoot, "logs/app.log"))).mode & 0o077, 0);
  const hostRecords = (
    await Bun.file(resolve(dataRoot, "logs/host.log")).text()
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    hostRecords.filter((record) => record.event === "host-stopped").length,
    1,
  );
  assert.equal(hostRecords.at(-1).failed, false);
  assert.equal(hostRecords.at(-1).forced, false);
  assert.equal(
    await Bun.file(resolve(dataRoot, "temp/stopped.json")).json(),
    true,
  );
  const records = (await Bun.file(resolve(dataRoot, "logs/app.log.1")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records.length, 36);
  assert.equal(records[0].source, "backend");
  assert.equal(records[0].message, "backend-ready");
  assert(
    records
      .slice(1, 33)
      .every(
        (record) =>
          record.source === "view:main" && record.message === "renderer",
      ),
  );
  assert.deepEqual(
    records.slice(1, 33).map((record) => record.details.index),
    Array.from(
      {
        length: 32,
      },
      (_, index) => index,
    ),
  );
  assert.equal(records[33].message, "recovered");
  for (let index = 0; index < 2; index++) {
    assert.equal(records[34 + index].source, "view:main");
    assert.equal(records[34 + index].message, `large-${index}`);
    assert.equal(records[34 + index].details.text, "x".repeat(524288));
  }
  const active = (await Bun.file(resolve(dataRoot, "logs/app.log")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(active.length, 1);
  assert.equal(active[0].message, "after-rotation");
  assert.equal(active[0].source, "view:main");
  assert.deepEqual(
    (await readdir(resolve(dataRoot, "logs")))
      .filter((name) => name.startsWith("app.log"))
      .sort(),
    [
      "app.log",
      "app.log.1",
    ],
  );
  assert(
    (await stat(resolve(dataRoot, "logs/app.log.1"))).size < 1.5 * 1024 * 1024,
  );
  await writeJson(resultPath, {
    ok: true,
    bunVersion: Bun.version,
    platform: process.platform,
    architecture: process.arch,
    appRecords: records.length + active.length,
    capabilities: expected,
    writeFailureRecovered: true,
    archiveReplaced: true,
  });
  console.log(
    "PASS compiled macOS host logging, attribution, operation grants, capability catalog and normal shutdown",
  );
} catch (error) {
  await writeJson(resultPath, {
    ok: false,
    error: String(error),
  });
  throw error;
} finally {
  if (child?.exitCode === null) {
    child.kill("SIGKILL");
  }
  await child?.exited;
  await rm(diagnostics, {
    recursive: true,
    force: true,
  });
  if (dataRoot && existsSync(dataRoot)) {
    await cp(dataRoot, diagnostics, {
      recursive: true,
    });
  }
  await rm(directory, {
    recursive: true,
    force: true,
  });
}
