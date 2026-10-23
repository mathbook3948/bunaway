import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineApp } from "@bunaway/backend";
import store from "@bunaway/plugin-store";
import windowState from "@bunaway/plugin-window-state";
import windows from "@bunaway/plugin-windows";
import type { HostContext, Policy } from "@bunaway/protocol";
import { runWindowsApp } from "#native/windows/bun/entry";
import { testAppMetadata } from "../fixtures/app-info.ts";
import { killAfter } from "../fixtures/deadlines.ts";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";
import { windowPermissions } from "../fixtures/window-permissions.ts";

assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-window-state");
const assets = resolve(output, "assets");
const reportPath = resolve(output, "report.json");
const grants = [
  ...windowPermissions(),
  ...store._definition.native.operations.map(({ name }) => name),
];
const policy: Policy = {
  version: 1,
  backend: {
    permissions: grants,
  },
  views: [
    {
      id: "main",
      origins: [
        "https://app.bunaway.local",
      ],
      commands: [
        "test.run",
      ],
      events: [],
      // Backend calls made for a command run with the permissions of the view that invoked it.
      host: {
        permissions: grants,
      },
    },
  ],
};

if (!process.argv.includes("--child")) {
  // A report left by an earlier run must not satisfy this one.
  await rm(reportPath, {
    force: true,
  });
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  await writeFile(
    resolve(assets, "web/index.html"),
    '<!doctype html><title>Window state</title><script type="module" src="/state.js"></script>',
  );
  const web = await Bun.build({
    entrypoints: [
      resolve(root, "tests/lifecycle/windows-bun/window-state.js"),
    ],
    target: "browser",
  });
  assert(web.success, web.logs.map(String).join("\n"));
  for (const artifact of web.outputs) {
    await writeFile(resolve(assets, "web/state.js"), await artifact.text());
  }
  const entry = await bundleNativeWorker(
    "windows-window-state",
    assets,
    fileURLToPath(import.meta.url),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      fileURLToPath(entry),
      "--child",
    ],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        BUNAWAY_STATE_TEST_ROOT: root,
      },
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const timer = killAfter(child, "nativeFixture");
  try {
    const code = await child.exited;
    assert.equal(code, 0, `${await stderr}\n${await stdout}`);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.pass, true, report.error);
    console.log(
      "PASS window state: bounds, maximized and fullscreen round trips, remove, off-screen fit on a real window",
    );
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill();
    }
    await child.exited;
  }
} else {
  // The bundled child has a different import.meta.dir; use the driver-selected repository root.
  const childRoot = process.env.BUNAWAY_STATE_TEST_ROOT;
  assert(childRoot);
  const childAssets = resolve(childRoot, "build/windows-window-state/assets");
  const childReport = resolve(
    childRoot,
    "build/windows-window-state/report.json",
  );
  const saved = {
    x: 150,
    y: 100,
    width: 600,
    height: 420,
  };
  const elsewhere = {
    x: 260,
    y: 180,
    width: 540,
    height: 380,
  };
  const normal = async () => {
    const { dpi: _dpi, ...bounds } = await windows.getNormalBounds({
      unit: "physical",
    });
    return bounds;
  };
  const place = (bounds: typeof saved) =>
    windows.setOuterBounds({
      unit: "physical",
      ...bounds,
    });
  const state = async () => (await windows.getSnapshot()).state;
  /** Put the window back to a plain, restored rectangle between scenarios. */
  const reset = async () => {
    await windows.setFullscreen({
      fullscreen: false,
    });
    await windows.unmaximize();
    await place(elsewhere);
  };
  async function scenario() {
    // Position and size round trip.
    await place(saved);
    await windowState.save();
    await place(elsewhere);
    assert.deepEqual(await normal(), elsewhere);
    assert.deepEqual(await windowState.restore(), {
      restored: true,
      adjusted: false,
    });
    assert.deepEqual(await normal(), saved);
    assert.equal((await state()).maximized, false);

    // Maximized: the normal rectangle is kept and the window maximizes again.
    await windows.maximize();
    await windowState.save({
      key: "maximized",
    });
    await reset();
    await windowState.restore({
      key: "maximized",
    });
    assert.equal(
      (await state()).maximized,
      true,
      "maximized after restoring a maximized record",
    );
    assert.deepEqual(await normal(), saved);
    await windows.unmaximize();
    assert.deepEqual(await normal(), saved);

    // A minimized window reports not maximized, so saving it keeps the maximized value saved
    // before. Restoring a tiny size into a minimized window stays inside the native size limits
    // instead of throwing.
    await place(saved);
    await windows.maximize();
    await windowState.save({
      key: "minimized",
    });
    await windows.minimize();
    assert.equal(
      (await state()).maximized,
      false,
      "a window minimized from maximized reports not maximized",
    );
    await windowState.save({
      key: "minimized",
    });
    const minimizedRecord = await store.get({
      name: "window-state",
      key: "minimized",
    });
    assert.equal(
      (
        minimizedRecord.value as {
          maximized: boolean;
        }
      ).maximized,
      true,
      "maximized kept when saving the window minimized",
    );
    await store.set({
      name: "window-state",
      key: "tiny",
      value: {
        version: 1,
        x: saved.x,
        y: saved.y,
        width: 100,
        height: 100,
        dpi: 96,
        maximized: false,
        fullscreen: false,
        visible: true,
      },
    });
    assert.equal((await state()).minimized, true, "window is minimized");
    assert.deepEqual(
      await windowState.restore({
        key: "tiny",
        include: {
          position: false,
          maximized: false,
          fullscreen: false,
        },
      }),
      {
        restored: true,
        adjusted: true,
      },
    );
    await windows.restore();
    const grown = await normal();
    assert(
      grown.width > 100 && grown.height > 100,
      `a minimized window is held to the raised minimum, got ${grown.width}x${grown.height}`,
    );
    await reset();

    // Fullscreen: restore leaves it, places the window and enters it again.
    await place(saved);
    await windows.setFullscreen({
      fullscreen: true,
    });
    await windowState.save({
      key: "fullscreen",
    });
    await windows.setFullscreen({
      fullscreen: false,
    });
    await place(elsewhere);
    // Restore starts from a fullscreen window: it must leave, place and enter again.
    await windows.setFullscreen({
      fullscreen: true,
    });
    assert.equal(
      (await state()).fullscreen,
      true,
      "fullscreen before restoring",
    );
    await windowState.restore({
      key: "fullscreen",
    });
    assert.equal(
      (await state()).fullscreen,
      true,
      "fullscreen after restoring a fullscreen record",
    );
    await windows.setFullscreen({
      fullscreen: false,
    });
    assert.deepEqual(await normal(), saved);
    await reset();

    // Only the selected fields are applied.
    await windowState.restore({
      include: {
        size: false,
        maximized: false,
        fullscreen: false,
      },
    });
    const partial = await normal();
    assert.equal(partial.x, saved.x);
    assert.equal(partial.y, saved.y);
    assert.equal(partial.width, elsewhere.width);
    assert.equal(partial.height, elsewhere.height);

    // A rectangle on no monitor moves into the primary work area.
    await store.set({
      name: "window-state",
      key: "gone",
      value: {
        version: 1,
        x: -100000,
        y: -100000,
        width: saved.width,
        height: saved.height,
        dpi: 96,
        maximized: false,
        fullscreen: false,
        visible: true,
      },
    });
    const fitted = await windowState.restore({
      key: "gone",
    });
    assert.deepEqual(fitted, {
      restored: true,
      adjusted: true,
    });
    const primary = await windows.getPrimaryMonitor();
    const placed = await normal();
    assert(placed.x >= primary.workArea.x);
    assert(placed.y >= primary.workArea.y);
    assert(
      placed.x + placed.width <= primary.workArea.x + primary.workArea.width,
    );
    assert(
      placed.y + placed.height <= primary.workArea.y + primary.workArea.height,
    );

    // Removing the state makes restore a no-op.
    assert.deepEqual(await windowState.remove(), {
      removed: true,
    });
    const before = await normal();
    assert.deepEqual(await windowState.restore(), {
      restored: false,
      adjusted: false,
    });
    assert.deepEqual(await normal(), before);
  }
  const app = defineApp({
    modules: [],
    plugins: [
      windows,
      store,
      windowState,
    ],
    commands: {
      "test.run": {
        input: {
          const: null,
        },
        output: {
          const: null,
        },
        async run() {
          try {
            await scenario();
            await writeFile(
              childReport,
              JSON.stringify({
                pass: true,
              }),
            );
          } catch (error) {
            // Report the failure instead of leaving the host to time out.
            await writeFile(
              childReport,
              JSON.stringify({
                pass: false,
                error: String(error instanceof Error ? error.stack : error),
              }),
            );
            throw error;
          } finally {
            await windows.close();
          }
          return null;
        },
      },
    },
  });
  await runWindowsApp(app, {
    appMetadata: testAppMetadata,
    runtime: {
      id: "window-state",
      generation: crypto.randomUUID(),
    },
    backendContext: `backend-${crypto.randomUUID()}` as HostContext,
    policy,
    assets: childAssets,
    dataRoot: resolve(
      childRoot,
      `build/windows-window-state/data-${process.pid}`,
    ),
    loader: resolve(
      childRoot,
      "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
    ),
    windows: [
      {
        view: "main",
        title: "Window state",
        home: "https://app.bunaway.local/index.html",
        window: {
          width: 640,
          height: 480,
        },
      },
    ],
  });
}
