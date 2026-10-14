import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { bundleMacosHost } from "#cli/assets";
import { files, hash, writeJson } from "#cli/files";
import { compileMacosApp } from "#cli/macos-compile";
import { installedPlugins } from "#cli/plugins";
import { run } from "#cli/processes";
import pin from "../../runtime/build-manifests/darwin-aarch64.json";

import {
  captureNativeChild,
  printNativeChildDiagnostics,
} from "../fixtures/native-child-diagnostics.ts";

assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
const root = resolve(import.meta.dir, "../..");
await run(
  [
    process.execPath,
    "--no-env-file",
    "test",
    resolve(import.meta.dir, "macos-appearance.test.ts"),
  ],
  root,
);
const directory = await mkdtemp(resolve(tmpdir(), "bunaway-macos-appearance-"));
let child: ReturnType<typeof Bun.spawn> | undefined;
const results: object[] = [];
let launchDiagnostics: string | undefined;
let launchDataRoot: string | undefined;
const diagnostics = resolve(root, "build/macos-appearance-diagnostics");
try {
  for (const backendAllowed of [
    true,
    false,
  ]) {
    const scenario = resolve(directory, backendAllowed ? "allowed" : "denied");
    const assets = resolve(scenario, "assets");
    await mkdir(resolve(assets, "web"), {
      recursive: true,
    });
    const views = [
      "main",
      "denied",
    ];
    const app = {
      appId: "tests.macos.appearance",
      windows: views.map((view) => ({
        view,
        home: `https://app.bunaway.local/${view}.html${backendAllowed ? "" : "?backend-denied"}`,
        title: `Appearance ${view}`,
        window: {
          width: 500,
          height: 400,
        },
      })),
    };
    const policy = {
      version: 1,
      backend: {
        permissions: backendAllowed
          ? [
              "appearance.getPreferences",
            ]
          : [],
      },
      views: views.map((view) => ({
        id: view,
        origins: [
          "https://app.bunaway.local",
        ],
        commands: [
          "test.backend",
          "test.inherited",
          "test.report",
          "plugin.appearance.getPreferences",
          "plugin.windows.close",
        ],
        events: [],
        host: {
          permissions: [
            "windows.close",
            ...(view === "main"
              ? [
                  "appearance.getPreferences",
                ]
              : []),
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
    const web = await Bun.build({
      entrypoints: [
        resolve(root, "tests/fixtures/macos-appearance/web.ts"),
      ],
      target: "browser",
      outdir: resolve(assets, "web"),
    });
    assert(web.success, web.logs.map(String).join("\n"));
    for (const output of web.outputs) {
      await Bun.write(output.path, await output.arrayBuffer());
    }
    for (const view of views) {
      await Bun.write(
        resolve(assets, "web", `${view}.html`),
        '<!doctype html><title>Appearance</title><script type="module" src="web.js"></script>',
      );
    }
    const installed = (await installedPlugins(root, "0.0.0")).filter((plugin) =>
      [
        "appearance",
        "windows",
      ].includes(plugin.name),
    );
    const bundled = await bundleMacosHost(
      resolve(root, "native/macos/bun"),
      assets,
      resolve(root, "tests/fixtures/macos-appearance/app.ts"),
      undefined,
      false,
      installed,
    );
    const executable = resolve(scenario, "bunaway-host");
    await compileMacosApp(assets, process.execPath, executable, bundled);
    const inventory: Record<string, string> = {};
    for (const file of await files(assets)) {
      inventory[relative(scenario, file)] = await hash(file);
    }
    await writeJson(resolve(scenario, "manifest.json"), {
      bun: pin.bun,
      assets: inventory,
      host: {
        kind: "bun-compiled",
        target: "macos-arm64",
      },
    });
    // Use the existing CI ad-hoc identity and FFI/JIT entitlements in a fixture-owned app.
    const appBundle = resolve(scenario, "Appearance.app");
    const resources = resolve(appBundle, "Contents/Resources");
    const signedExecutable = resolve(appBundle, "Contents/MacOS/bunaway-host");
    await mkdir(resolve(appBundle, "Contents/MacOS"), {
      recursive: true,
    });
    await mkdir(resources, {
      recursive: true,
    });
    await cp(executable, signedExecutable);
    await cp(assets, resolve(resources, "assets"), {
      recursive: true,
    });
    await cp(
      resolve(scenario, "manifest.json"),
      resolve(resources, "manifest.json"),
    );
    await Bun.write(
      resolve(appBundle, "Contents/Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>bunaway-host</string>
<key>CFBundleIdentifier</key><string>tests.macos.appearance</string>
<key>CFBundleName</key><string>Appearance fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
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
        appBundle,
      ],
      root,
    );
    await run(
      [
        "/usr/bin/codesign",
        "--verify",
        "--deep",
        "--strict",
        appBundle,
      ],
      root,
    );
    for (let launch = 0; launch < 2; launch++) {
      const home = resolve(scenario, `home-${launch}`);
      await mkdir(home);
      const launched = Bun.spawn(
        [
          signedExecutable,
          "--package",
          resources,
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
      const dataRoot = resolve(
        home,
        "Library/Application Support/bunaway/tests.macos.appearance",
      );
      launchDataRoot = dataRoot;
      launchDiagnostics = resolve(
        diagnostics,
        backendAllowed ? "allowed" : "denied",
        `launch-${launch}`,
      );
      const {
        exitCode: code,
        stdout,
        stderr,
      } = await captureNativeChild(
        launched,
        launchDiagnostics,
        `appearance ${backendAllowed ? "allowed" : "denied"} launch ${launch}`,
        30_000,
      );
      const log = await Bun.file(resolve(dataRoot, "logs/host.log"))
        .text()
        .catch(() => "No host log.");
      assert.equal(code, 0, `${stdout}\n${stderr}\n${log}`);
      const report = await Bun.file(
        resolve(dataRoot, "temp/report.json"),
      ).json();
      assert.deepEqual(
        report.toSorted(
          (
            a: {
              view: string;
            },
            b: {
              view: string;
            },
          ) => a.view.localeCompare(b.view),
        ),
        [
          {
            view: "denied",
            ok: true,
          },
          {
            view: "main",
            ok: true,
          },
        ],
      );
      const records = log
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(
        records.filter((record) => record.event === "host-stopped").length,
        1,
      );
      assert.equal(records.at(-1).failed, false);
      results.push({
        backendAllowed,
        launch,
        report,
      });
    }
  }
  await writeJson(resolve(root, "build/macos-appearance-results.json"), {
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    results,
  });
  console.log(
    "PASS signed compiled macOS appearance: repeated AppKit reads, backend/view grants and denials, strict input, bounded colors, adapter lifetimes and repeated host shutdown",
  );
} catch (error) {
  if (launchDiagnostics && launchDataRoot) {
    await printNativeChildDiagnostics(launchDiagnostics, launchDataRoot);
    const logs = resolve(launchDataRoot, "logs");
    if (await Bun.file(resolve(logs, "host.log")).exists()) {
      await cp(logs, resolve(launchDiagnostics, "host-logs"), {
        recursive: true,
      });
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
