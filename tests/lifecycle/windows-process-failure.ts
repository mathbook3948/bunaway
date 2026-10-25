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
import { rendererPids } from "./windows-host-processes.ts";

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
        "test.arm",
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
    // The backend is waiting once it wrote the marker; the failure then cannot be missed.
    await waitFor(
      () =>
        access(armedPath).then(
          () => true,
          () => false,
        ),
      {
        deadline: "nativeFixture",
        what: "the backend to wait for a process failure",
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
    const code = await child.exited;
    assert.equal(code, 0, `${await stderr}\n${await stdout}`);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.failure.viewId, "main");
    assert.equal(report.failure.windowId, report.windowId);
    // Killing the renderer is a renderer exit, and the host reloads the view in place.
    assert.equal(report.failure.kind, "renderer-exited");
    assert.equal(report.failure.recovery, "reload");
    assert.equal(report.failure.sequence, 1);
    assert.equal(
      report.reloaded,
      true,
      "page did not reload after the renderer exit",
    );
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
  let armCount = 0;
  let firstArm: Promise<void> | undefined;
  const app = defineApp({
    modules: [],
    plugins: [
      windows,
    ],
    commands: {
      "test.arm": {
        input: {
          const: null,
        },
        output: {
          const: null,
        },
        async run() {
          armCount++;
          if (firstArm) {
            return null;
          }
          firstArm = (async () => {
            const waiting = windows.waitForProcessFailure();
            await writeFile(
              resolve(childRoot, "build/windows-process-failure/armed"),
              "",
            );
            const failure = await waiting;
            // The reloaded page arms again once it is ready, which proves the view recovered.
            await waitFor(() => (armCount > 1 ? true : undefined), {
              deadline: "childStep",
              what: "the reloaded page",
            });
            const snapshot = await windows.getSnapshot();
            await writeFile(
              resolve(childRoot, "build/windows-process-failure/report.json"),
              JSON.stringify({
                failure,
                windowId: snapshot.windowId,
                reloaded: armCount > 1,
              }),
            );
            await windows.close();
          })();
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
