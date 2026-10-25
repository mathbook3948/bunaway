import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineApp } from "@bunaway/backend";
import windows from "@bunaway/plugin-windows";
import type { HostContext, Policy } from "@bunaway/protocol";
import { runWindowsApp } from "#native/windows/bun/entry";
import { testAppMetadata } from "../fixtures/app-info.ts";
import { killAfter, waitFor } from "../fixtures/deadlines.ts";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";
import { windowPermissions } from "../fixtures/window-permissions.ts";
import { closeAllWindows, rendererPids } from "./windows-host-processes.ts";

assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-process-failure");
const assets = resolve(output, "assets");
const dataRoot = resolve(output, "data");
const armedPath = resolve(output, "armed");
const reportPath = resolve(output, "report.json");
const policy: Policy = {
  version: 1,
  backend: {
    permissions: [
      ...windowPermissions(),
    ],
  },
  views: [
    {
      id: "main",
      origins: [
        "https://app.bunaway.local",
      ],
      commands: [
        "test.loaded",
      ],
      events: [],
      host: {
        permissions: [
          ...windowPermissions(),
        ],
      },
    },
  ],
};

if (!process.argv.includes("--child")) {
  await rm(output, {
    recursive: true,
    force: true,
  });
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  await writeFile(
    resolve(assets, "web/index.html"),
    '<!doctype html><title>Process failure</title><script type="module" src="/failure.js"></script>',
  );
  const web = await Bun.build({
    entrypoints: [
      resolve(root, "tests/lifecycle/windows-bun/process-failure.js"),
    ],
    target: "browser",
  });
  assert(web.success, web.logs.map(String).join("\n"));
  for (const artifact of web.outputs) {
    await writeFile(resolve(assets, "web/failure.js"), await artifact.text());
  }
  const entry = await bundleNativeWorker(
    "windows-process-failure",
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
        BUNAWAY_FAILURE_TEST_ROOT: root,
      },
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const timeout = killAfter(child, "nativeFixture");
  try {
    // The first page load marks the window as ready for the kill; the backend wait replays history either way.
    await waitFor(
      () =>
        access(armedPath).then(
          () => true,
          () => false,
        ),
      {
        deadline: "nativeFixture",
        what: "the first page load",
      },
    );
    const pids = await waitFor(
      async () => {
        const found = await rendererPids(dataRoot, "main");
        return found.length > 0 ? found : undefined;
      },
      {
        deadline: "childStep",
        what: "the WebView2 renderer process",
        intervalMs: 200,
      },
    );
    for (const pid of pids) {
      const killer = Bun.spawn(
        [
          "taskkill",
          "/F",
          "/PID",
          String(pid),
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      assert.equal(await killer.exited, 0, "renderer termination failed");
    }
    await waitFor(
      () =>
        access(reportPath).then(
          () => true,
          () => false,
        ),
      {
        deadline: "childStep",
        what: "the backend report",
      },
    );
    // The driver closes the window like a user would; the backend has nothing left to do.
    await closeAllWindows(child.pid);
    const code = await child.exited;
    assert.equal(code, 0, `${await stderr}\n${await stdout}`);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.error, undefined, report.error);
    assert.equal(report.failure.viewId, "main");
    // Both loads belong to the same window, which is the one the failure names.
    assert.deepEqual(report.windowIds, [
      report.failure.windowId,
      report.failure.windowId,
    ]);
    // Killing the renderer is a renderer exit, and the host reloads the view in place.
    assert.equal(report.failure.kind, "renderer-exited");
    assert.equal(report.failure.recovery, "reload");
    assert.equal(report.failure.sequence, 1);
    console.log(
      "PASS WebView2 process failure: backend receives renderer-exited with a reload, the view reloads, and the window id is unchanged",
    );
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) {
      child.kill();
    }
    await child.exited;
  }
} else {
  // The bundled child has a different import.meta.dir; use the driver-selected repository root.
  const childRoot = process.env.BUNAWAY_FAILURE_TEST_ROOT;
  assert(childRoot);
  const childAssets = resolve(
    childRoot,
    "build/windows-process-failure/assets",
  );
  const dir = resolve(childRoot, "build/windows-process-failure");
  const windowIds: string[] = [];
  const app = defineApp({
    modules: [],
    plugins: [
      windows,
      {
        name: "process-failure-watch",
        version: "1",
        // A setup scope outlives commands, so the wait survives the page and its session being revoked.
        setup() {
          // `after: 0` replays retained history, so a failure that lands before the wait registers is kept.
          void (async () => {
            const failure = await windows.waitForProcessFailure({
              after: 0,
            });
            // The reloaded page reports itself again once it is ready, which proves the view recovered.
            await waitFor(() => (windowIds.length > 1 ? true : undefined), {
              deadline: "childStep",
              what: "the reloaded page",
            });
            await writeFile(
              resolve(dir, "report.json"),
              JSON.stringify({
                failure,
                windowIds,
              }),
            );
          })().catch(async (error: unknown) => {
            // Surface the cause to the driver instead of leaving it to an opaque timeout.
            await writeFile(
              resolve(dir, "report.json"),
              JSON.stringify({
                error: String(error),
              }),
            );
          });
        },
      },
    ],
    commands: {
      "test.loaded": {
        input: {
          const: null,
        },
        output: {
          const: null,
        },
        async run() {
          windowIds.push((await windows.getSnapshot()).windowId);
          if (windowIds.length === 1) {
            await writeFile(resolve(dir, "armed"), "");
          }
          return null;
        },
      },
    },
  });
  await runWindowsApp(app, {
    appMetadata: testAppMetadata,
    runtime: {
      id: "process-failure",
      generation: crypto.randomUUID(),
    },
    backendContext: `backend-${crypto.randomUUID()}` as HostContext,
    policy,
    assets: childAssets,
    dataRoot: resolve(childRoot, "build/windows-process-failure/data"),
    loader: resolve(
      childRoot,
      "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
    ),
    windows: [
      {
        view: "main",
        title: "Process failure main",
        home: "https://app.bunaway.local/index.html",
        window: {
          width: 640,
          height: 480,
        },
      },
    ],
  });
}
