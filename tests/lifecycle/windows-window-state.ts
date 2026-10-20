import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
const target = {
  view: "main",
};
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
      host: {
        permissions: [],
      },
    },
  ],
};

if (!process.argv.includes("--child")) {
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
    assert.equal(report.pass, true);
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
      ...target,
      unit: "physical",
    });
    return bounds;
  };
  const place = (bounds: typeof saved) =>
    windows.setOuterBounds({
      ...target,
      unit: "physical",
      ...bounds,
    });
  const state = async () => (await windows.getSnapshot(target)).state;
  /** Put the window back to a plain, restored rectangle between scenarios. */
  const reset = async () => {
    await windows.setFullscreen({
      ...target,
      fullscreen: false,
    });
    await windows.unmaximize(target);
    await place(elsewhere);
  };
  async function scenario() {
    // Position and size round trip.
    await place(saved);
    await windowState.save(target);
    await place(elsewhere);
    assert.deepEqual(await normal(), elsewhere);
    assert.deepEqual(await windowState.restore(target), {
      restored: true,
      adjusted: false,
    });
    assert.deepEqual(await normal(), saved);
    assert.equal((await state()).maximized, false);

    // Maximized: the normal rectangle is kept and the window maximizes again.
    await windows.maximize(target);
    await windowState.save({
      ...target,
      key: "maximized",
    });
    await reset();
    await windowState.restore({
      ...target,
      key: "maximized",
    });
    assert.equal((await state()).maximized, true);
    assert.deepEqual(await normal(), saved);
    await windows.unmaximize(target);
    assert.deepEqual(await normal(), saved);

    // Fullscreen: restore leaves it, places the window and enters it again.
    await place(saved);
    await windows.setFullscreen({
      ...target,
      fullscreen: true,
    });
    await windowState.save({
      ...target,
      key: "fullscreen",
    });
    await windows.setFullscreen({
      ...target,
      fullscreen: false,
    });
    await place(elsewhere);
    await windowState.restore({
      ...target,
      key: "fullscreen",
    });
    assert.equal((await state()).fullscreen, true);
    await windows.setFullscreen({
      ...target,
      fullscreen: false,
    });
    assert.deepEqual(await normal(), saved);
    await reset();

    // Only the selected fields are applied.
    await windowState.restore({
      ...target,
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
      ...target,
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
    assert.deepEqual(await windowState.remove(target), {
      removed: true,
    });
    const before = await normal();
    assert.deepEqual(await windowState.restore(target), {
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
            await windows.close(target);
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
