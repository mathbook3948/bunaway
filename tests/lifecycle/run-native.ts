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
    await run(
      [
        inputs.bun,
        "--no-env-file",
        "test",
        resolve(root, "tests/lifecycle/windows-aspect-ratio.test.ts"),
      ],
      root,
    );
    await run(
      [
        inputs.bun,
        "--no-env-file",
        "test",
        resolve(root, "tests/lifecycle/windows-resizable-maximize.test.ts"),
      ],
      root,
    );
    // Own process: the test shows windows and switches the thread's DPI awareness while capturing.
    await run(
      [
        inputs.bun,
        "--no-env-file",
        "test",
        resolve(root, "tests/lifecycle/windows-screen-capture.test.ts"),
      ],
      root,
    );
    await run(
      [
        inputs.bun,
        "--no-env-file",
        "test",
        resolve(root, "tests/lifecycle/windows-window-drag.test.ts"),
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
    await test("windows-app-exit.ts");
    await test("windows-bun-window-api.ts");
    await test("windows-webview-print-ui.ts");
    await test("windows-webview-capture-page.ts");
    await test("windows-webview-downloads.ts");
    await test("windows-webview-controls.ts");
    await test("windows-webview-audio.ts");
    await test("windows-webview-titlebar.ts");
    await test("windows-webview-color-scheme.ts");
    await test("windows-menu-roles.ts");
    await test("windows-menu-auto-hide.ts");
    await test("windows-initial-placement.ts");
    await test("windows-window-events.ts");
    await test("windows-window-state.ts");
    await test("windows-window-input-events.ts");
    await test("windows-document-title.ts");
    await test("windows-document-favicon.ts");
    await test("windows-html-fullscreen.ts");
    await test("windows-process-failure.ts");
    await test("windows-hidden-paint.ts");
    await test("windows-monitor-events.ts");
    await run(
      [
        inputs.bun,
        "--no-env-file",
        "test",
        resolve(root, "tests/lifecycle/windows-system-events.test.ts"),
        resolve(root, "tests/lifecycle/windows-power-events.test.ts"),
      ],
      root,
    );
    await test("windows-window-readiness.ts");
    await test("windows-close-request.ts");
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
        resolve(root, "tests/lifecycle/windows-trash-limits.test.ts"),
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
          "tests/lifecycle/windows-process-spawn.test.ts",
          "tests/lifecycle/process-run.test.ts",
          "tests/lifecycle/windows-network.test.ts",
          "tests/lifecycle/windows-network-download.test.ts",
          "tests/lifecycle/windows-network-upload.test.ts",
          "tests/lifecycle/windows-network-online.test.ts",
          "tests/lifecycle/windows-network-resolve-host.test.ts",
          "tests/lifecycle/windows-network-resolve-proxy.test.ts",
          "tests/lifecycle/windows-updater-signature.test.ts",
          "tests/lifecycle/windows-updater-msix.test.ts",
          "tests/lifecycle/windows-global-shortcut.test.ts",
          "tests/lifecycle/windows-global-shortcut-ui.test.ts",
          "tests/lifecycle/windows-menu.test.ts",
          "tests/lifecycle/windows-menu-icon.test.ts",
          "tests/lifecycle/windows-menu-accelerator.test.ts",
          "tests/lifecycle/windows-window-menu.test.ts",
          "tests/lifecycle/windows-menu-ui.test.ts",
          "tests/lifecycle/windows-tray-balloon.test.ts",
          "tests/lifecycle/windows-tray-controls.test.ts",
          "tests/lifecycle/windows-tray-icon.test.ts",
          "tests/lifecycle/windows-tray-popup.test.ts",
          "tests/lifecycle/windows-tray-ui.test.ts",
          "tests/lifecycle/windows-bun-instance.test.ts",
          "tests/lifecycle/windows-monitors.test.ts",
          "tests/lifecycle/windows-monitor-events.test.ts",
          "tests/lifecycle/windows-host-shutdown.test.ts",
          "tests/lifecycle/windows-power.test.ts",
          "tests/lifecycle/windows-power-cpu-speed-limit.test.ts",
          "tests/lifecycle/windows-power-ui.test.ts",
          "tests/lifecycle/windows-appearance.test.ts",
          "tests/lifecycle/windows-appearance-accessibility.test.ts",
          "tests/lifecycle/windows-opener.test.ts",
          "tests/lifecycle/windows-opener-job.test.ts",
          "tests/lifecycle/windows-opener-selected-app.test.ts",
          "tests/lifecycle/windows-opener-recent.test.ts",
          "tests/lifecycle/windows-opener-url-handler.test.ts",
          "tests/lifecycle/windows-opener-file-icon.test.ts",
          "tests/lifecycle/windows-opener-url-scheme.test.ts",
          "tests/lifecycle/windows-opener-shortcut.test.ts",
          "tests/lifecycle/windows-opener-jump-list.test.ts",
          "tests/lifecycle/windows-notification.test.ts",
          "tests/lifecycle/windows-notification-activator.test.ts",
          "tests/lifecycle/windows-dialog.test.ts",
          "tests/lifecycle/windows-toast.test.ts",
          "tests/lifecycle/windows-webview-version.test.ts",
          "tests/cli/windows-assets.test.ts",
          "tests/cli/windows-compile.test.ts",
        ].map((name) => resolve(root, name)),
      ],
      root,
    );
    // Own process: the probe starts a compiled executable through Explorer and selects a file in an
    // Explorer window, so it must not share a process with the other opener tests.
    await run(
      [
        inputs.bun,
        "--no-env-file",
        "test",
        resolve(root, "tests/cli/opener.test.ts"),
      ],
      root,
      {
        BUNAWAY_OPENER_FILES_TEST: "1",
      },
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
      "lifecycle",
      "boot-forward-lifecycle",
      "dev-lifecycle",
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
      "tray-hidden",
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
    // Session end is delivered to a real app window, keep-alive control window and tray window.
    for (const scenario of [
      "window",
      "control",
      "tray",
    ]) {
      await test("windows-session-end.ts", [
        scenario,
      ]);
    }
    for (const name of [
      "windows-bun-storage.ts",
      "windows-storage-metadata.ts",
      "windows-storage-directory-size.ts",
      "windows-storage-copy-directory.ts",
      "windows-storage-directory-page.ts",
      "windows-storage-recursive-list.ts",
      "windows-storage-remove-recursive.ts",
      "windows-storage-long-path.ts",
      "windows-storage-create-new.ts",
      "windows-storage-atomic-write.ts",
      "windows-path.ts",
      "windows-safe-storage.ts",
      "windows-bun-cli.ts",
      "windows-app-reload.ts",
      "windows-baseline.ts",
      "windows-templates.ts",
    ]) {
      await test(name);
    }
    await run(
      [
        inputs.bun,
        "--no-env-file",
        "test",
        resolve(root, "tests/lifecycle/windows-image.test.ts"),
        resolve(root, "tests/lifecycle/windows-image-file-icon.test.ts"),
        resolve(root, "tests/lifecycle/windows-image-file.test.ts"),
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
    await test("macos-webview-recreate.ts");
    await test("macos-window-api.ts");
    await test("macos-global-shortcut.ts");
    await test("macos-webview-controls.ts");
    await test("macos-io-host.ts");
    await test("macos-desktop.ts");
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
    await test("macos-store.ts");
    await test("macos-autostart-host.ts");
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
    await run(
      [
        inputs.bun,
        "--no-env-file",
        "test",
        resolve(root, "tests/lifecycle/macos-os.test.ts"),
      ],
      root,
    );
    await run(
      [
        inputs.bun,
        "--no-env-file",
        "test",
        resolve(root, "tests/lifecycle/macos-tray-native.test.ts"),
      ],
      root,
      {
        BUNAWAY_TRAY_NATIVE: "1",
      },
    );
    await run(
      [
        inputs.bun,
        "--no-env-file",
        "test",
        resolve(root, "tests/lifecycle/macos-power.test.ts"),
      ],
      root,
    );
    await run(
      [
        inputs.bun,
        "--no-env-file",
        "test",
        resolve(root, "tests/lifecycle/macos-dialog-native.test.ts"),
      ],
      root,
      {
        BUNAWAY_DIALOG_NATIVE: "1",
      },
    );
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
