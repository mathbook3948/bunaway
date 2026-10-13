import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { bundleMacosHost } from "#cli/assets";
import { files, hash, writeJson } from "#cli/files";
import { compileMacosApp } from "#cli/macos-compile";
import { type InstalledPlugin, installedPlugins } from "#cli/plugins";
import pin from "../../runtime/build-manifests/darwin-aarch64.json";
import { probe } from "../fixtures/macos-io/probe.ts";

assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
const root = resolve(import.meta.dir, "../..");
const directory = await mkdtemp(resolve(tmpdir(), "bunaway-macos-io-"));
let child: ReturnType<typeof Bun.spawn> | undefined;
try {
  const assets = resolve(directory, "assets");
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  const commands = [
    "test.phase",
    "test.ping",
    "test.responsive",
    "test.marker",
    "test.release",
    "test.report",
    ...[
      "run",
      "inspect",
      "snapshot",
      "unsupported",
      "denied",
    ].map((name) => `plugin.probe.${name}`),
    "plugin.windows.recreate",
    "plugin.windows.close",
  ];
  const policy = {
    version: 1,
    backend: {
      permissions: [
        "probe.run",
      ],
    },
    views: [
      {
        id: "main",
        origins: [
          "https://app.bunaway.local",
        ],
        commands,
        events: [],
        host: {
          permissions: [
            "probe.run",
            "probe.inspect",
            "probe.snapshot",
            "probe.unsupported",
            "windows.recreate",
            "windows.close",
          ],
        },
      },
    ],
  };
  const app = {
    appId: "tests.macos.io",
    windows: [
      {
        view: "main",
        home: "https://app.bunaway.local/",
        title: "I/O lifecycle",
        window: {
          width: 500,
          height: 400,
        },
      },
    ],
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
      name: probe.definition.name,
      version: probe.definition.version,
      packageName: "fixture-probe",
      root,
      native: probe.definition.native,
      targets: {
        macos: {
          execution: "io",
          operations: resolve(root, "tests/fixtures/macos-io/native.ts"),
          supportedOperations: [
            "probe.run",
            "probe.inspect",
            "probe.snapshot",
            "probe.denied",
          ],
        },
      },
    },
  ];
  const bundled = await bundleMacosHost(
    resolve(root, "native/macos/bun"),
    assets,
    resolve(root, "tests/fixtures/macos-io/app.ts"),
    undefined,
    false,
    installed,
  );
  const web = await Bun.build({
    entrypoints: [
      resolve(root, "tests/fixtures/macos-io/web.ts"),
    ],
    target: "browser",
    outdir: resolve(assets, "web"),
  });
  assert(web.success, web.logs.map(String).join("\n"));
  for (const output of web.outputs) {
    await Bun.write(output.path, await output.arrayBuffer());
  }
  await Bun.write(
    resolve(assets, "web/index.html"),
    '<!doctype html><title>I/O lifecycle</title><script type="module" src="web.js"></script>',
  );
  const executable = resolve(directory, "bunaway-host");
  await compileMacosApp(assets, process.execPath, executable, bundled);
  const inventory: Record<string, string> = {};
  for (const file of await files(assets)) {
    inventory[relative(directory, file)] = await hash(file);
  }
  await writeJson(resolve(directory, "manifest.json"), {
    bun: pin.bun,
    assets: inventory,
  });
  const reports: object[] = [];
  for (const scenario of [
    "normal",
    "init-failure",
    "block-cleanup",
  ] as const) {
    const home = resolve(directory, scenario);
    const dataRoot = resolve(
      home,
      "Library/Application Support/bunaway",
      app.appId,
    );
    await mkdir(dataRoot, {
      recursive: true,
    });
    if (scenario !== "normal") {
      await Bun.write(resolve(dataRoot, scenario), "enabled");
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
        timeout: 30_000,
      },
    );
    child = launched;
    const output = new Response(launched.stdout).text();
    const errors = new Response(launched.stderr).text();
    const exitCode = await launched.exited;
    await output;
    const stderr = await errors;
    assert.equal(exitCode, scenario === "normal" ? 0 : 1, stderr);
    const temporary = resolve(dataRoot, "temp");
    const records = (await Bun.file(resolve(dataRoot, "logs/host.log")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      records.filter((record) => record.event === "host-stopped").length,
      1,
    );
    const stopped = records.at(-1);
    assert.equal(stopped.failed, scenario !== "normal");
    assert.equal(stopped.forced, scenario === "block-cleanup");
    if (scenario === "init-failure") {
      assert.match(stderr, /Fixture I\/O initialization failed/);
      assert.equal(
        await Bun.file(resolve(temporary, "setup-executed")).exists(),
        false,
      );
    } else {
      assert.deepEqual(
        await Bun.file(resolve(temporary, "report.json")).json(),
        {
          ok: true,
          phase: 3,
        },
      );
      assert.equal(
        await Bun.file(resolve(temporary, "cancelled-executed")).exists(),
        false,
      );
      assert.equal(
        await Bun.file(resolve(temporary, "revoked-executed")).exists(),
        false,
      );
      assert.equal(
        await Bun.file(resolve(temporary, "denied-parsed")).exists(),
        false,
      );
      assert.equal(
        await Bun.file(resolve(temporary, "core-cleaned")).text(),
        "done",
      );
      assert.equal(
        await Bun.file(resolve(temporary, "io-cleaned")).exists(),
        scenario === "normal",
      );
      assert.equal(
        records.filter((record) => record.event === "session-open").length,
        2,
      );
    }
    reports.push({
      scenario,
      exitCode,
      stopped,
    });
  }
  await writeJson(resolve(root, "build/macos-io-results.json"), {
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    revision: Bun.revision,
    reports,
  });
  console.log(
    "PASS compiled WKWebView -> host -> I/O Worker, source, policy, support, nonblocking AppKit, cancellation, revocation, initialization failure and shutdown deadline",
  );
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
