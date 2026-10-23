import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { bundleMacosHost } from "#cli/assets";
import { files, hash, writeJson } from "#cli/files";
import { compileMacosApp } from "#cli/macos-compile";
import { type InstalledPlugin, installedPlugins } from "#cli/plugins";
import pin from "../../runtime/build-manifests/darwin-aarch64.json";
import { testAppMetadata } from "../fixtures/app-info.ts";
import { fixturePlugin } from "../fixtures/macos-safe-storage/plugin.ts";
import { keychainFixture } from "./fixtures/macos-keychain.ts";

assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
const root = resolve(import.meta.dir, "../..");
const directory = await mkdtemp(
  resolve(tmpdir(), "bunaway-safe-storage-host-"),
);
const appId = "tests.macos.safe-storage";
const reports: object[] = [];
const fixturePaths: string[] = [];
let child: ReturnType<typeof Bun.spawn> | undefined;
const cleanup = async () => {
  const errors: unknown[] = [];
  if (child?.exitCode === null) {
    child.kill("SIGKILL");
  }
  await child?.exited;
  for (const path of fixturePaths) {
    if (
      !(await Bun.file(path).exists()) &&
      !(await Bun.file(`${path}-db`).exists())
    ) {
      continue;
    }
    const fixture = keychainFixture();
    try {
      fixture.open(path);
      fixture.dispose(true);
    } catch (error) {
      errors.push(error);
    } finally {
      fixture.dispose(false);
    }
  }
  await rm(directory, {
    recursive: true,
    force: true,
  });
  if (errors.length) {
    throw new AggregateError(errors, "Disposable Keychain cleanup failed");
  }
};
try {
  const assets = resolve(directory, "assets");
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  const allOperations = Object.values(
    fixturePlugin._definition.native.operations,
  ).map((value) => value.name);
  const viewOperations = allOperations.filter(
    (name) => name !== "safe-storage.decryptBytes",
  );
  const policy = {
    version: 1,
    backend: {
      permissions: allOperations,
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
          ...allOperations.map((name) => `plugin.${name}`),
          "plugin.windows.close",
        ],
        host: {
          permissions: [
            ...viewOperations,
            "windows.close",
          ],
        },
      },
    ],
  };
  const app = {
    appId,
    title: "Safe storage fixture",
    view: "main",
    home: "https://app.bunaway.local/",
    window: {
      width: 400,
      height: 300,
    },
  };
  await writeJson(resolve(assets, "manifest.json"), {
    format: 1,
    app,
    policy,
    plugins: [],
    developmentSdk: {},
  });
  const installed: InstalledPlugin[] = [
    ...(await installedPlugins(root, "0.0.0")).filter(
      (plugin) => plugin.name === "windows",
    ),
    {
      name: fixturePlugin._definition.name,
      version: fixturePlugin._definition.version,
      packageName: "fixture-safe-storage",
      root,
      native: fixturePlugin._definition.native,
      targets: {
        macos: {
          thread: "worker",
          operations: resolve(
            root,
            "tests/fixtures/macos-safe-storage/plugin.ts",
          ),
        },
      },
    },
  ];
  const bundled = await bundleMacosHost(
    resolve(root, "native/macos/bun"),
    assets,
    resolve(root, "tests/fixtures/macos-safe-storage/app.ts"),
    undefined,
    false,
    installed,
  );
  const web = await Bun.build({
    entrypoints: [
      resolve(root, "tests/fixtures/macos-safe-storage/web.ts"),
    ],
    target: "browser",
    outdir: resolve(assets, "web"),
  });
  assert(web.success, web.logs.map(String).join("\n"));
  await Bun.write(
    resolve(assets, "web/index.html"),
    '<!doctype html><title>Safe storage fixture</title><script type="module" src="web.js"></script>',
  );
  const executable = resolve(directory, "safe-storage-host");
  await compileMacosApp(assets, process.execPath, executable, bundled);
  const signed = Bun.spawn(
    [
      "/usr/bin/codesign",
      "--force",
      "--sign",
      "-",
      "--entitlements",
      resolve(root, "native/macos/bun/entitlements.plist"),
      executable,
    ],
    {
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  assert.equal(await signed.exited, 0, "Ad-hoc fixture signing failed");
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

  for (const mode of [
    "shared-bun",
    "compiled",
  ] as const) {
    const home = resolve(directory, mode);
    const temporary = resolve(
      home,
      "Library/Application Support/bunaway",
      appId,
      "temp",
    );
    await mkdir(temporary, {
      recursive: true,
    });
    fixturePaths.push(resolve(temporary, "synthetic.keychain"));
    for (const restart of [
      false,
      true,
    ]) {
      for (const marker of [
        "core-cleaned",
        "native-cleaned",
        "web-report",
        "backend-report.json",
      ]) {
        await rm(resolve(temporary, marker), {
          force: true,
        });
      }
      const args =
        mode === "compiled"
          ? [
              executable,
              "--package",
              directory,
            ]
          : [
              process.execPath,
              "--no-env-file",
              "--no-install",
              resolve(assets, "boot.js"),
              "--package",
              directory,
            ];
      const launched = Bun.spawn(args, {
        env: {
          ...process.env,
          HOME: home,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 45000,
      });
      child = launched;
      const [output, errors, code] = await Promise.all([
        new Response(launched.stdout).text(),
        new Response(launched.stderr).text(),
        launched.exited,
      ]);
      assert.equal(code, 0, `${mode} ${restart}: ${errors}\n${output}`);
      assert.deepEqual(
        await Bun.file(resolve(temporary, "backend-report.json")).json(),
        {
          restarted: restart,
          roundTrip: true,
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
      assert.equal(
        await Bun.file(resolve(temporary, "native-cleaned")).text(),
        "done",
      );
      const identity = await Bun.file(
        resolve(temporary, "trusted-app.json"),
      ).json();
      assert.equal(identity.id, appId);
      assert.equal(
        identity.launch.mode,
        mode === "compiled" ? "packaged" : "development",
      );
      const log = resolve(temporary, "../logs/host.log");
      const stopped = (await Bun.file(log).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .at(-1);
      assert.equal(stopped.event, "host-stopped");
      assert.equal(stopped.failed, false);
      assert.equal(stopped.forced, false);
      reports.push({
        mode,
        restart,
        backendRoundTrip: true,
        webviewRoundTrip: true,
        policyDenial: true,
        callerIdentityRejected: true,
        cleanup: true,
      });
    }
  }
  await writeJson(resolve(root, "build/macos-safe-storage-results.json"), {
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    revision: Bun.revision,
    reports,
  });
  console.log(
    "PASS actual WKWebView and production safe-storage factory in shared Bun and ad-hoc compiled hosts, same-executable restart, policy and trusted identity, private Keychain and cleanup",
  );
} catch (error) {
  const diagnostics = resolve(root, "build/macos-safe-storage-diagnostics");
  await mkdir(diagnostics, {
    recursive: true,
  });
  for (const mode of [
    "shared-bun",
    "compiled",
  ]) {
    const logs = resolve(
      directory,
      mode,
      "Library/Application Support/bunaway",
      appId,
      "logs",
    );
    if (await Bun.file(resolve(logs, "host.log")).exists()) {
      await cp(logs, resolve(diagnostics, mode), {
        recursive: true,
      });
    }
  }
  await writeJson(resolve(root, "build/macos-safe-storage-results.json"), {
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    revision: Bun.revision,
    reports,
    failure: error instanceof Error ? error.message : String(error),
  });
  throw error;
} finally {
  await cleanup();
}
