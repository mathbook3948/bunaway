import assert from "node:assert/strict";
import { realpathSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { AUTOSTART_ARGUMENT } from "@bunaway/protocol";
import { bundleMacosHost } from "#cli/assets";
import { files, hash, writeJson } from "#cli/files";
import { compileMacosApp } from "#cli/macos-compile";
import { installedPlugins } from "#cli/plugins";
import pin from "../../runtime/build-manifests/darwin-aarch64.json";
import { testAppMetadata } from "../fixtures/app-info.ts";

assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
const root = resolve(import.meta.dir, "../..");
const directory = await mkdtemp(resolve(tmpdir(), "bunaway-autostart-host-"));
const appId = "tests.macos.autostart";
const resultPath = resolve(root, "build/macos-autostart-results.json");
const registered = [
  "--login",
  "한글 값",
  '인용"값',
];
const reports: object[] = [];
let child: ReturnType<typeof Bun.spawn> | undefined;

async function plist(path: string) {
  const converted = Bun.spawn(
    [
      "/usr/bin/plutil",
      "-convert",
      "json",
      "-o",
      "-",
      path,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [text, errors, code] = await Promise.all([
    new Response(converted.stdout).text(),
    new Response(converted.stderr).text(),
    converted.exited,
  ]);
  assert.equal(code, 0, errors);
  return JSON.parse(text);
}

try {
  const assets = resolve(directory, "assets");
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  const policy = {
    version: 1,
    backend: {
      permissions: [
        "autostart.enable",
        "autostart.disable",
        "autostart.getStatus",
      ],
    },
    views: [
      {
        id: "main",
        origins: [
          "https://app.bunaway.local",
        ],
        events: [],
        commands: [
          "plugin.windows.close",
        ],
        host: {
          permissions: [
            "windows.close",
          ],
        },
      },
    ],
  };
  await writeJson(resolve(assets, "manifest.json"), {
    format: 1,
    app: {
      appId,
      title: "Autostart fixture",
      windows: [
        {
          view: "main",
          home: "https://app.bunaway.local/",
          title: "Autostart fixture",
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
  const installed = (await installedPlugins(root, "0.0.0")).filter((plugin) =>
    [
      "windows",
      "autostart",
    ].includes(plugin.name),
  );
  assert.equal(installed.length, 2);
  const bundled = await bundleMacosHost(
    resolve(root, "native/macos/bun"),
    assets,
    resolve(root, "tests/fixtures/macos-autostart/app.ts"),
    undefined,
    false,
    installed,
  );
  const web = await Bun.build({
    entrypoints: [
      resolve(root, "tests/fixtures/macos-autostart/web.ts"),
    ],
    target: "browser",
    outdir: resolve(assets, "web"),
  });
  assert(web.success, web.logs.map(String).join("\n"));
  await Bun.write(
    resolve(assets, "web/index.html"),
    '<!doctype html><title>Autostart fixture</title><script type="module" src="web.js"></script>',
  );
  const executable = resolve(directory, "autostart-host");
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
    const launchMode = mode === "compiled" ? "packaged" : "development";
    const name = `bunaway.${launchMode}.${appId}`;
    const file = resolve(home, "Library/LaunchAgents", `${name}.plist`);
    const launcher = mode === "compiled" ? executable : process.execPath;
    for (const restart of [
      false,
      true,
    ]) {
      await rm(resolve(temporary, "backend-report.json"), {
        force: true,
      });
      const launched = Bun.spawn(
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
            ],
        {
          env: {
            ...process.env,
            HOME: home,
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 45000,
        },
      );
      child = launched;
      const [output, errors, code] = await Promise.all([
        new Response(launched.stdout).text(),
        new Response(launched.stderr).text(),
        launched.exited,
      ]);
      assert.equal(code, 0, `${mode} ${restart}: ${errors}\n${output}`);
      const report = await Bun.file(
        resolve(temporary, "backend-report.json"),
      ).json();
      const stored = (status: {
        registrationName: string;
        registered: boolean;
        executablePath: string | null;
        args: string[] | null;
        startupState: string;
        matchesCurrentLaunch: boolean;
      }) => {
        assert.equal(status.registrationName, name);
        assert.equal(status.registered, true);
        // macOS has no public API for the Login Items approval, so it stays unknown.
        assert.equal(status.startupState, "unknown");
        assert.equal(status.matchesCurrentLaunch, true);
        assert(status.executablePath);
        assert.equal(
          realpathSync(status.executablePath),
          realpathSync(launcher),
        );
        assert(status.args);
        assert(status.args.includes("--package"));
        assert.deepEqual(status.args.slice(-registered.length - 1), [
          AUTOSTART_ARGUMENT,
          ...registered,
        ]);
      };
      if (restart) {
        // The registration written by the previous run is read back by a new host process.
        stored(report.before);
      } else {
        assert.equal(report.before.registered, false);
        assert.equal(report.before.registrationName, name);
        assert.equal(report.before.executablePath, null);
      }
      stored(report.enabled);
      assert.deepEqual(report.repeated, report.enabled);
      assert.equal(report.hiddenCode, "INVALID_ARGUMENT");
      // A rejected hidden request leaves the stored registration unchanged.
      assert.deepEqual(report.afterHidden, report.enabled);
      assert.equal(report.disabled, null);
      assert.equal(report.removed.registered, false);
      assert.equal(report.removed.executablePath, null);
      assert.equal(report.removed.args, null);
      assert.equal(report.disabledAgain, null);
      assert.deepEqual(report.final, report.enabled);

      // The file launchd loads is a valid property list with the reported launch.
      const lint = Bun.spawn(
        [
          "/usr/bin/plutil",
          "-lint",
          file,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      assert.equal(
        await lint.exited,
        0,
        await new Response(lint.stderr).text(),
      );
      const agent = await plist(file);
      assert.deepEqual(agent, {
        Label: name,
        ProgramArguments: [
          report.final.executablePath,
          ...report.final.args,
        ],
        RunAtLoad: true,
      });
      assert.equal(statSync(file).mode & 0o777, 0o644);
      reports.push({
        mode,
        restart,
        stored: true,
        hiddenRejected: true,
        removed: true,
        plistValid: true,
      });
    }
    await rm(file);
  }
  await writeJson(resultPath, {
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    reports,
  });
  console.log(
    "PASS macOS autostart LaunchAgent enable, repeat, hidden rejection, disable, restart read-back and plist validity in shared Bun and compiled hosts",
  );
} catch (error) {
  const diagnostics = resolve(root, "build/macos-autostart-diagnostics");
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
  await writeJson(resultPath, {
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    reports,
    failure: error instanceof Error ? error.message : String(error),
  });
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
