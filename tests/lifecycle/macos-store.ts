import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { NativeRegistry, type Policy } from "@bunaway/protocol";
import { bundleMacosHost } from "#cli/assets";
import { files, hash, writeJson } from "#cli/files";
import { compileMacosApp } from "#cli/macos-compile";
import { installedPlugins } from "#cli/plugins";
import { run } from "#cli/processes";
import pin from "../../runtime/build-manifests/darwin-aarch64.json";
import { testAppMetadata } from "../fixtures/app-info.ts";

assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
const root = resolve(import.meta.dir, "../..");
const directory = await mkdtemp(resolve(tmpdir(), "bunaway-macos-store-"));
const appId = "tests.macos.store";
const home = resolve(directory, "home");
const dataRoot = resolve(home, "Library/Application Support/bunaway", appId);
const diagnostics = resolve(root, "build/macos-store-diagnostics");
const resultPath = resolve(root, "build/macos-store-results.json");
const reports: object[] = [];
let child: ReturnType<typeof Bun.spawn> | undefined;
try {
  const assets = resolve(directory, "assets");
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  const installed = (await installedPlugins(root, "0.0.0")).filter((plugin) =>
    [
      "store",
      "windows",
    ].includes(plugin.name),
  );
  const store = installed.find((plugin) => plugin.name === "store");
  assert(store, "The store plugin is not installed.");
  const storeOperations = store.native.operations.map(
    (operation) => operation.name,
  );
  assert(storeOperations.length > 0);
  const policy: Policy = {
    version: 1,
    backend: {
      permissions: storeOperations,
    },
    views: [
      {
        id: "main",
        origins: [
          "https://app.bunaway.local",
        ],
        events: [],
        commands: [
          "test.report",
          "plugin.store.get",
          "plugin.store.set",
          "plugin.windows.close",
        ],
        host: {
          permissions: [
            "store.get",
            "windows.close",
          ],
        },
      },
    ],
  };
  new NativeRegistry(installed, {
    mode: "catalog",
  }).validatePolicy(policy);
  await writeJson(resolve(assets, "manifest.json"), {
    format: 1,
    app: {
      appId,
      title: "Store fixture",
      windows: [
        {
          view: "main",
          home: "https://app.bunaway.local/",
          title: "Store fixture",
          window: {
            width: 400,
            height: 300,
          },
        },
      ],
    },
    policy,
    plugins: [],
    developmentSdk: {},
  });
  const bundled = await bundleMacosHost(
    resolve(root, "native/macos/bun"),
    assets,
    resolve(root, "tests/fixtures/macos-store/app.ts"),
    undefined,
    false,
    installed,
  );
  const web = await Bun.build({
    entrypoints: [
      resolve(root, "tests/fixtures/macos-store/web.ts"),
    ],
    target: "browser",
    outdir: resolve(assets, "web"),
  });
  assert(web.success, web.logs.map(String).join("\n"));
  await Bun.write(
    resolve(assets, "web/index.html"),
    '<!doctype html><title>Store fixture</title><script type="module" src="web.js"></script>',
  );
  const executable = resolve(directory, "store-host");
  await compileMacosApp(assets, process.execPath, executable, bundled);
  await run(
    [
      "/usr/bin/codesign",
      "--force",
      "--sign",
      "-",
      "--entitlements",
      resolve(root, "native/macos/bun/entitlements.plist"),
      executable,
    ],
    root,
  );
  const inventory: Record<string, string> = {};
  for (const file of await files(assets)) {
    inventory[relative(directory, file)] = await hash(file);
  }
  await writeJson(resolve(directory, "manifest.json"), {
    bun: pin.bun,
    assets: inventory,
    app: {
      id: appId,
      version: testAppMetadata.version,
    },
    framework: {
      version: testAppMetadata.framework,
    },
  });
  const temporary = resolve(dataRoot, "temp");
  await mkdir(temporary, {
    recursive: true,
  });
  // The same executable runs twice: the second run starts from the files the first one left.
  for (const restart of [
    false,
    true,
  ]) {
    for (const marker of [
      "core-cleaned",
      "web-report",
      "backend-report.json",
    ]) {
      await rm(resolve(temporary, marker), {
        force: true,
      });
    }
    const launched = Bun.spawn(
      [
        executable,
        "--package",
        directory,
      ],
      {
        env: {
          ...process.env,
          HOME: home,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
      },
    );
    child = launched;
    const [output, errors, code] = await Promise.all([
      new Response(launched.stdout).text(),
      new Response(launched.stderr).text(),
      launched.exited,
    ]);
    assert.equal(code, 0, `restart ${restart}: ${errors}\n${output}`);
    assert.deepEqual(
      await Bun.file(resolve(temporary, "backend-report.json")).json(),
      {
        restarted: restart,
      },
    );
    assert.equal(
      await Bun.file(resolve(temporary, "web-report")).text(),
      "passed",
    );
    assert.equal(
      await Bun.file(resolve(temporary, "core-cleaned")).text(),
      "done",
    );
    const stopped = (await Bun.file(resolve(dataRoot, "logs/host.log")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .at(-1);
    assert.equal(stopped.event, "host-stopped");
    assert.equal(stopped.failed, false);
    assert.equal(stopped.forced, false);
    reports.push({
      restart,
      backendScenarios: true,
      viewPolicy: true,
      cleanShutdown: true,
    });
  }
  await writeJson(resultPath, {
    ok: true,
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    reports,
  });
  console.log(
    "PASS compiled macOS host store: defaults, save, reload, reset, failed save, damaged file, autosave, shutdown flush, restart and view permissions",
  );
} catch (error) {
  await writeJson(resultPath, {
    ok: false,
    reports,
    failure: error instanceof Error ? error.message : String(error),
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
  if (await Bun.file(resolve(dataRoot, "logs/host.log")).exists()) {
    await cp(resolve(dataRoot, "logs"), diagnostics, {
      recursive: true,
    });
  }
  await rm(directory, {
    recursive: true,
    force: true,
  });
}
