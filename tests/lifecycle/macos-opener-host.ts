import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { bundleMacosHost } from "#cli/assets";
import { files, hash, writeJson } from "#cli/files";
import { compileMacosApp } from "#cli/macos-compile";
import { installedPlugins } from "#cli/plugins";
import pin from "../../runtime/build-manifests/darwin-aarch64.json";
import {
  createReceiver,
  fixtureCommand,
} from "../fixtures/macos-opener-receiver-app.ts";

assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
assert.equal(
  process.env.BUNAWAY_OPENER_ISOLATED,
  "1",
  "Requires a disposable fixture session.",
);
const root = resolve(import.meta.dir, "../..");
const directory = await realpath(
  await mkdtemp(resolve(tmpdir(), "bunaway-opener-host-")),
);
const home = resolve(directory, "fixture-home");
const dataRoot = resolve(
  home,
  "Library/Application Support/bunaway/tests.macos.opener",
);
let receiver: Awaited<ReturnType<typeof createReceiver>> | undefined;
let child: ReturnType<typeof Bun.spawn> | undefined;
let stderr = "";
try {
  receiver = await createReceiver(directory);
  const assets = resolve(directory, "assets");
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  const commands = [
    "test.report",
    "test.denied",
    "test.wait",
    "plugin.windows.close",
    ...[
      "openUrl",
      "openFile",
      "revealFile",
      "openFileWith",
    ].map((name) => `plugin.opener.${name}`),
  ];
  const windows = [
    "main",
    "denied",
  ].map((view) => ({
    view,
    home: `https://app.bunaway.local/${view}.html?file=${encodeURIComponent(receiver?.sample ?? "")}`,
    title: `Opener ${view}`,
    window: {
      width: 500,
      height: 400,
    },
  }));
  await writeJson(resolve(assets, "manifest.json"), {
    format: 1,
    app: {
      appId: "tests.macos.opener",
      title: "Opener",
      windows,
    },
    policy: {
      version: 1,
      backend: {
        permissions: [],
      },
      views: windows.map(({ view }) => ({
        id: view,
        origins: [
          "https://app.bunaway.local",
        ],
        commands,
        events: [],
        host: {
          permissions: [
            "windows.close",
            ...(view === "main"
              ? [
                  "opener.openFile",
                  "opener.revealFile",
                  "opener.openUrl",
                  "opener.openFileWith",
                ]
              : []),
          ],
        },
      })),
    },
    plugins: [],
    developmentSdk: {},
  });
  const installed = (await installedPlugins(root, "0.0.0")).filter(
    ({ name }) => name === "opener" || name === "windows",
  );
  assert.equal(
    installed.find(({ name }) => name === "opener")?.targets.macos?.thread,
    "worker",
  );
  const bundled = await bundleMacosHost(
    resolve(root, "native/macos/bun"),
    assets,
    resolve(root, "tests/fixtures/macos-opener-host-app.ts"),
    undefined,
    false,
    installed,
  );
  const web = await Bun.build({
    entrypoints: [
      resolve(root, "tests/fixtures/macos-opener-host-web.ts"),
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
      '<!doctype html><title>Opener fixture</title><script type="module" src="macos-opener-host-web.js"></script>',
    );
  }
  const app = resolve(directory, "Opener Host.app");
  const executable = resolve(app, "Contents/MacOS/bunaway-host");
  await mkdir(resolve(app, "Contents/MacOS"), {
    recursive: true,
  });
  await writeFile(
    resolve(app, "Contents/Info.plist"),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>tests.macos.opener</string><key>CFBundleExecutable</key><string>bunaway-host</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>',
  );
  await compileMacosApp(assets, process.execPath, executable, bundled);
  const inventory: Record<string, string> = {};
  for (const file of await files(assets)) {
    inventory[relative(directory, file)] = await hash(file);
  }
  await writeJson(resolve(directory, "manifest.json"), {
    bun: pin.bun,
    assets: inventory,
  });
  await fixtureCommand([
    "/usr/bin/codesign",
    "--force",
    "--sign",
    "-",
    "--entitlements",
    resolve(root, "native/macos/bun/entitlements.plist"),
    app,
  ]);
  await fixtureCommand([
    "/usr/bin/codesign",
    "--verify",
    "--strict",
    app,
  ]);
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
      timeout: 30000,
    },
  );
  child = launched;
  const output = new Response(launched.stdout).text();
  const errors = new Response(launched.stderr).text();
  const code = await launched.exited;
  await output;
  stderr = await errors;
  assert.equal(code, 0, stderr);
  const report = await Bun.file(resolve(dataRoot, "temp/report.json")).json();
  assert.deepEqual(report, {
    ok: true,
    file: receiver.sample,
    requests: [
      "openFile",
      "revealFile",
      "openUrl.http",
      "openUrl.https",
    ],
    denied: true,
    unsupported: "openFileWith",
    cancelled: true,
  });
  await receiver.waitFor(receiver.received);
  const records = (await Bun.file(resolve(dataRoot, "logs/host.log")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    records.filter((record) => record.event === "host-stopped").length,
    1,
  );
  assert.equal(records.at(-1).failed, false);
  assert.equal(records.at(-1).forced, false);
  await mkdir(resolve(root, "build"), {
    recursive: true,
  });
  await writeJson(resolve(root, "build/macos-opener-host-results.json"), {
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    revision: Bun.revision,
    report,
    events: await receiver.readEvents(),
    stopped: records.at(-1),
  });
  console.log(
    "PASS signed compiled WKWebView -> Core -> macOS host -> real opener I/O adapter, POSIX public helpers, file delivery, URL/Finder acceptance, permissions, cancellation, selected-app unsupported and clean shutdown",
  );
} catch (error) {
  const diagnostics = resolve(root, "build/macos-opener-host-diagnostics");
  await mkdir(diagnostics, {
    recursive: true,
  });
  if (await Bun.file(resolve(dataRoot, "logs/host.log")).exists()) {
    await cp(resolve(dataRoot, "logs"), diagnostics, {
      recursive: true,
    });
  }
  await writeJson(resolve(root, "build/macos-opener-host-results.json"), {
    failure: error instanceof Error ? error.message : String(error),
    stderr,
  });
  throw error;
} finally {
  try {
    if (child?.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child?.exited;
  } finally {
    try {
      await receiver?.dispose();
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  }
}
