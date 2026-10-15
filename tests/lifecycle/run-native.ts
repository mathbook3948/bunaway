import assert from "node:assert/strict";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { currentTarget, prepareNative } from "#cli/build";
import { run } from "#cli/processes";

const root = resolve(import.meta.dir, "../..");
const { values } = parseArgs({
  options: {
    target: {
      type: "string",
    },
    "skip-tests": {
      type: "boolean",
      default: false,
    },
    app: {
      type: "boolean",
      default: false,
    },
  },
});
const target = currentTarget();
assert(
  values.target === undefined || values.target === target,
  `Native tests require ${values.target}; current target is ${target}`,
);
const inputs = await prepareNative(target);
const test = (
  name: string,
  args: string[] = [],
  env: Record<string, string> = {},
) =>
  run(
    [
      inputs.bun,
      "--no-env-file",
      resolve(import.meta.dir, name),
      ...args,
    ],
    root,
    env,
  );
if (target === "windows-x64") {
  const { buildHostFixture } = await import("#native/windows/bun/package");
  const output = await buildHostFixture();
  if (!values["skip-tests"]) {
    // Keep style/geometry probes in an owned process, independent of shared UI-service lifetimes.
    await run(
      [
        inputs.bun,
        "--no-env-file",
        "test",
        resolve(root, "tests/lifecycle/windows-display.test.ts"),
      ],
      root,
    );
    for (const scenario of [
      [],
      [
        "--modal",
      ],
      [
        "--early-close",
      ],
      [
        "--creation-failure",
      ],
    ]) {
      await test("windows-bun.ts", scenario);
    }
    await test("windows-cli-arguments.ts");
    await test("windows-bun-window-api.ts");
    await test("windows-webview-print-ui.ts");
    await test("windows-webview-downloads.ts");
    await test("windows-webview-controls.ts");
    await test("windows-webview-audio.ts");
    await test("windows-webview-titlebar.ts");
    await test("windows-initial-placement.ts");
    await test("windows-window-events.ts");
    await test("windows-monitor-events.ts");
    await run(
      [
        inputs.bun,
        "--no-env-file",
        "test",
        resolve(root, "tests/lifecycle/windows-system-events.test.ts"),
      ],
      root,
    );
    await test("windows-window-readiness.ts");
    await test("windows-multiple-windows.ts");
    await test("windows-owned-modal.ts");
    await run(
      [
        inputs.bun,
        "--no-env-file",
        "test",
        resolve(root, "tests/lifecycle/windows-clipboard.test.ts"),
      ],
      root,
      {
        BUNAWAY_CLIPBOARD_NATIVE: "1",
      },
    );
    // Shell recycling can retain process-wide COM workers after STA disposal.
    // Isolate its native test so opener probes keep their fresh-process invariant.
    await run(
      [
        inputs.bun,
        "--no-env-file",
        "test",
        resolve(root, "tests/lifecycle/windows-trash.test.ts"),
      ],
      root,
    );
    await run(
      [
        inputs.bun,
        "--no-env-file",
        "test",
        ...[
          "tests/lifecycle/desktop.test.ts",
          "tests/lifecycle/windows-os.test.ts",
          "tests/lifecycle/windows-process.test.ts",
          "tests/lifecycle/process-run.test.ts",
          "tests/lifecycle/windows-network.test.ts",
          "tests/lifecycle/windows-global-shortcut.test.ts",
          "tests/lifecycle/windows-global-shortcut-ui.test.ts",
          "tests/lifecycle/windows-menu.test.ts",
          "tests/lifecycle/windows-menu-ui.test.ts",
          "tests/lifecycle/windows-tray-controls.test.ts",
          "tests/lifecycle/windows-tray-ui.test.ts",
          "tests/lifecycle/windows-bun-instance.test.ts",
          "tests/lifecycle/windows-monitors.test.ts",
          "tests/lifecycle/windows-monitor-events.test.ts",
          "tests/lifecycle/windows-host-shutdown.test.ts",
          "tests/lifecycle/windows-power.test.ts",
          "tests/lifecycle/windows-power-worker.test.ts",
          "tests/lifecycle/windows-appearance.test.ts",
          "tests/lifecycle/windows-opener.test.ts",
          "tests/lifecycle/windows-opener-job.test.ts",
          "tests/lifecycle/windows-opener-selected-app.test.ts",
          "tests/lifecycle/windows-notification.test.ts",
          "tests/lifecycle/windows-toast.test.ts",
          "tests/cli/windows-assets.test.ts",
          "tests/cli/windows-compile.test.ts",
        ].map((name) => resolve(root, name)),
      ],
      root,
    );
    for (const scenario of [
      "hide",
      "autostart",
      "autostart-hidden",
      "autostart-hidden-ready",
      "veto",
      "dev-veto",
      "dev-hide",
      "dev-pending",
    ]) {
      await test("windows-desktop.ts", [
        scenario,
      ]);
    }
    for (const scenario of [
      "resident",
      "resident-empty",
      "tray",
      "tray-empty",
      "nonfocusable-resident",
      "nonfocusable-tray",
      "destroy-resident",
      "destroy-resident-tray",
      "destroy-recreate-resident",
      "destroy-recreate-tray",
      "dev-resident",
      "dev-tray",
      "dev-pending-tray",
      "force-tray",
    ]) {
      await test("windows-windowless.ts", [
        scenario,
      ]);
    }
    for (const name of [
      "windows-bun-storage.ts",
      "windows-storage-metadata.ts",
      "windows-path.ts",
      "windows-safe-storage.ts",
      "windows-bun-cli.ts",
      "windows-app-reload.ts",
    ]) {
      await test(name);
    }
    await run(
      [
        inputs.bun,
        "--no-env-file",
        "test",
        resolve(root, "tests/lifecycle/windows-image.test.ts"),
      ],
      root,
    );
    await test("windows-host.ts", [
      "--package",
      output,
    ]);
  }
} else {
  const { buildMacosFixture, buildSignedFixture } = await import(
    "#native/macos/bun/package"
  );
  const output = await buildMacosFixture();
  if (values.app) {
    await buildSignedFixture(output);
  }
  if (!values["skip-tests"]) {
    await test("macos-appearance.ts");
    await test("macos-webview-regressions.ts");
    await test("macos-window-api.ts");
    await test("macos-webview-controls.ts");
    await test("macos-io-host.ts");
    await test("macos-image-host.ts");
    await run(
      [
        inputs.bun,
        "--no-env-file",
        "test",
        resolve(root, "tests/lifecycle/macos-webview-diagnostics.test.ts"),
      ],
      root,
    );
    await test("macos-network.ts");
    await test("macos-log-capabilities.ts");
    await run(
      [
        inputs.bun,
        "--no-env-file",
        "test",
        resolve(root, "tests/lifecycle/macos-clipboard-adapter.test.ts"),
        resolve(root, "tests/lifecycle/macos-clipboard-native.test.ts"),
      ],
      root,
      {
        BUNAWAY_CLIPBOARD_NATIVE: "1",
      },
    );
    await test("macos-clipboard-webview.ts", [], {
      BUNAWAY_CLIPBOARD_NATIVE: "1",
    });
    await test("macos-storage-host.ts");
    if (process.env.BUNAWAY_OPENER_ISOLATED === "1") {
      await run(
        [
          inputs.bun,
          "--no-env-file",
          "test",
          resolve(root, "tests/lifecycle/macos-opener.test.ts"),
          resolve(root, "tests/lifecycle/macos-opener-native.test.ts"),
        ],
        root,
      );
      await test("macos-opener-host.ts");
    }
    await test("macos-host.ts", [
      "--package",
      output,
    ]);
    if (values.app) {
      const app = resolve(root, "build/Bunaway.app");
      await test(
        "macos-host.ts",
        [
          "--package",
          resolve(app, "Contents/Resources"),
        ],
        {
          BUNAWAY_PACKAGE_IN_PLACE: "1",
          BUNAWAY_HOST_EXEC: resolve(app, "Contents/MacOS/bunaway-host"),
          BUNAWAY_TEST_WORKSPACE: resolve(root, "build/macos-host-in-place"),
          BUNAWAY_TEST_SIGN_IDENTITY: "-",
        },
      );
      await run(
        [
          process.execPath,
          "--no-env-file",
          "test",
          resolve(root, "tests/packaging/macos-distribution.test.ts"),
        ],
        root,
        {
          BUNAWAY_DISTRIBUTION_APP: app,
        },
      );
    }
  }
}
