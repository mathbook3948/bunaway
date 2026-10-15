import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { bundleMacosHost } from "#cli/assets";
import { files, hash, writeJson } from "#cli/files";
import { compileMacosApp } from "#cli/macos-compile";
import { installedPlugins } from "#cli/plugins";
import { run } from "#cli/processes";
import pin from "../../runtime/build-manifests/darwin-aarch64.json";
import { captureMacosNativeChild } from "../fixtures/macos-startup-diagnostics.ts";
import { printNativeChildDiagnostics } from "../fixtures/native-child-diagnostics.ts";

assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
const root = resolve(import.meta.dir, "../..");
const directory = await realpath(
  await mkdtemp(resolve(tmpdir(), "bunaway-storage-host-")),
);
let child: ReturnType<typeof Bun.spawn> | undefined;
const reports: object[] = [];
let launchDiagnostics: string | undefined;
const diagnostics = resolve(root, "build/macos-storage-host-diagnostics");
try {
  const assets = resolve(directory, "assets");
  const home = resolve(directory, "home");
  const storageRoot = resolve(
    home,
    "Library/Application Support/bunaway/tests.macos.storage/storage",
  );
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  await mkdir(storageRoot, {
    recursive: true,
  });
  await mkdir(home, {
    recursive: true,
  });
  await Bun.write(resolve(storageRoot, "outside"), "outside");
  await symlink(
    resolve(storageRoot, "outside"),
    resolve(storageRoot, "symlink"),
  );
  await mkdir(resolve(storageRoot, "directory-fixture/folder"), {
    recursive: true,
  });
  await Bun.write(
    resolve(storageRoot, "directory-fixture/한글🙂.txt"),
    "direct child",
  );
  await Bun.write(
    resolve(storageRoot, "directory-fixture/folder/hidden"),
    "nested child",
  );
  await symlink(
    resolve(storageRoot, "outside"),
    resolve(storageRoot, "directory-fixture/link"),
  );
  await symlink(
    resolve(storageRoot, "missing"),
    resolve(storageRoot, "directory-fixture/dangling"),
  );
  const operations = [
    "readText",
    "writeText",
    "readBytes",
    "writeBytes",
    "appendText",
    "appendBytes",
    "copyFile",
    "move",
    "readDirectory",
    "createDirectory",
    "remove",
    "exists",
    "stat",
  ];
  const commands = [
    "test.paths",
    "test.backendViaView",
    "test.report",
    "plugin.windows.close",
    ...operations.map((name) => `plugin.storage.${name}`),
  ];
  const app = {
    appId: "tests.macos.storage",
    windows: [
      "main",
      "denied",
    ].map((view) => ({
      view,
      home: `https://app.bunaway.local/${view}.html`,
      title: `Storage ${view}`,
      window: {
        width: 500,
        height: 400,
      },
    })),
  };
  const policy = {
    version: 1,
    backend: {
      permissions: [
        "storage.exists",
        "storage.readText",
        "storage.writeText",
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
      commands,
      events: [],
      host: {
        permissions:
          id === "main"
            ? [
                "windows.close",
                ...operations.map((name) => `storage.${name}`),
              ]
            : [
                "windows.close",
                "storage.readText",
              ],
      },
    })),
  };
  await writeJson(resolve(assets, "manifest.json"), {
    format: 1,
    app,
    policy,
    plugins: [],
    developmentSdk: {},
  });
  const installed = (await installedPlugins(root, "0.0.0")).filter((plugin) =>
    [
      "windows",
      "storage",
    ].includes(plugin.name),
  );
  const storage = installed.find((plugin) => plugin.name === "storage");
  assert.equal(storage?.targets.macos?.thread, "worker");
  assert.equal(
    (storage.targets.macos.supportedOperations ?? []).includes("storage.move"),
    false,
  );
  assert.equal(
    (storage.targets.macos.supportedOperations ?? []).includes(
      "storage.remove",
    ),
    false,
  );
  for (const operation of [
    "storage.readDirectory",
    "storage.createDirectory",
  ]) {
    assert(
      (storage.targets.macos.supportedOperations ?? []).includes(operation),
    );
  }
  const bundled = await bundleMacosHost(
    resolve(root, "native/macos/bun"),
    assets,
    resolve(root, "tests/fixtures/macos-storage/app.ts"),
    undefined,
    false,
    installed,
  );
  const web = await Bun.build({
    entrypoints: [
      resolve(root, "tests/fixtures/macos-storage/web.ts"),
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
      resolve(assets, `web/${view}.html`),
      '<!doctype html><title>Storage</title><script type="module" src="web.js"></script>',
    );
  }
  const executable = resolve(directory, "bunaway-host");
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
  await run(
    [
      "/usr/bin/codesign",
      "--verify",
      "--strict",
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
  });
  for (const restarted of [
    false,
    true,
  ]) {
    await rm(resolve(storageRoot, "core-cleaned"), {
      force: true,
    });
    for (const view of [
      "main",
      "denied",
    ]) {
      await rm(resolve(storageRoot, `${view}-report.json`), {
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
      },
    );
    child = launched;
    launchDiagnostics = resolve(diagnostics, restarted ? "restart" : "initial");
    const { exitCode, stdout, stderr } = await captureMacosNativeChild(
      launched,
      launchDiagnostics,
      restarted ? "storage restart" : "storage initial",
      30_000,
      resolve(home, "Library/Application Support/bunaway/tests.macos.storage"),
    );
    assert.equal(exitCode, 0, `${stdout}\n${stderr}`);
    for (const view of [
      "main",
      "denied",
    ]) {
      assert.deepEqual(
        await Bun.file(resolve(storageRoot, `${view}-report.json`)).json(),
        {
          view,
          ok: true,
          restarted,
          message: "passed",
        },
      );
    }
    assert.equal(
      await Bun.file(resolve(storageRoot, "denied.txt")).text(),
      "preserved",
    );
    assert.equal(
      await Bun.file(resolve(storageRoot, "outside")).text(),
      "outside",
    );
    assert.equal(
      await Bun.file(resolve(storageRoot, "core-cleaned")).text(),
      "done",
    );
    reports.push({
      restarted,
      exitCode,
    });
  }
  await writeJson(resolve(root, "build/macos-storage-host-results.json"), {
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    revision: Bun.revision,
    reports,
  });
  console.log(
    "PASS ad-hoc signed WKWebView -> host -> storage I/O, eleven operations, directory contracts, operation grants, view authority, unsupported move/remove, cleanup and restart",
  );
} catch (error) {
  if (launchDiagnostics) {
    await printNativeChildDiagnostics(
      launchDiagnostics,
      resolve(
        directory,
        "home/Library/Application Support/bunaway/tests.macos.storage",
      ),
    );
  }
  await mkdir(diagnostics, {
    recursive: true,
  });
  const logs = resolve(
    directory,
    "home/Library/Application Support/bunaway/tests.macos.storage/logs",
  );
  if (await Bun.file(resolve(logs, "host.log")).exists()) {
    await cp(logs, resolve(diagnostics, "logs"), {
      recursive: true,
    });
  }
  for (const view of [
    "main",
    "denied",
  ]) {
    const report = resolve(
      directory,
      "home/Library/Application Support/bunaway/tests.macos.storage/storage",
      `${view}-report.json`,
    );
    if (await Bun.file(report).exists()) {
      await cp(report, resolve(diagnostics, `${view}-report.json`));
    }
  }
  throw error;
} finally {
  if (child?.exitCode === null) {
    child.kill("SIGKILL");
  }
  await child?.exited;
  await rm(directory, {
    recursive: true,
    force: true,
  });
}
