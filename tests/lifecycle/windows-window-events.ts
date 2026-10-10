import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineApp } from "@bunaway/backend";
import {
  windowEvents,
  windowSnapshotSchema,
  windows,
  windowsPlugin,
} from "@bunaway/plugin-windows";
import {
  type HostContext,
  type Policy,
  validateValue,
} from "@bunaway/protocol";
import { runWindowsApp } from "#native/windows/bun/entry";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";

assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-window-events");
const assets = resolve(output, "assets");
const reportPath = resolve(output, "report.json");
const target = {
  view: "main",
};
const grant = {
  identifier: "windows:control",
  allow: [
    target,
    {
      view: "denied",
    },
  ],
};
const policy: Policy = {
  version: 1,
  backend: {
    permissions: [
      grant,
    ],
  },
  views: [
    "main",
    "denied",
  ].map((id) => ({
    id,
    origins: [
      "https://app.bunaway.local",
    ],
    commands:
      id === "main"
        ? [
            "test.exercise",
            "test.record",
            "test.unsubscribed",
            "test.recreate",
            "test.finish",
            "plugin.windows.getSnapshot",
          ]
        : [
            "test.denied",
          ],
    events:
      id === "main"
        ? [
            "windows.changed",
          ]
        : [],
    host: {
      permissions:
        id === "main"
          ? [
              grant,
            ]
          : [],
    },
  })),
};
const noInput = {
  input: {
    const: null,
  },
  output: {
    const: null,
  },
} as const;

if (!process.argv.includes("--child")) {
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  await writeFile(
    resolve(assets, "web/index.html"),
    '<!doctype html><title>Window events</title><script type="module" src="/events.js"></script>',
  );
  await writeFile(
    resolve(assets, "web/denied.html"),
    '<!doctype html><title>Denied events</title><script type="module" src="/events.js"></script>',
  );
  const web = await Bun.build({
    entrypoints: [
      resolve(root, "tests/lifecycle/windows-bun/window-events.js"),
    ],
    target: "browser",
  });
  assert(web.success, web.logs.map(String).join("\n"));
  for (const artifact of web.outputs) {
    await writeFile(resolve(assets, "web/events.js"), await artifact.text());
  }
  const entry = await bundleNativeWorker(
    "windows-window-events",
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
        BUNAWAY_EVENT_TEST_ROOT: root,
      },
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const timeout = setTimeout(() => child.kill(), 90000);
  try {
    const code = await child.exited;
    assert.equal(code, 0, `${await stderr}\n${await stdout}`);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.pass, true);
    assert.equal(report.documents, 3);
    assert.equal(report.denied, true);
    console.log(
      "PASS WebView2 native events: delivery, permission denial, snapshot recovery, unlisten, navigation, recreation, shutdown",
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
  const childRoot = process.env.BUNAWAY_EVENT_TEST_ROOT;
  assert(childRoot);
  const childAssets = resolve(childRoot, "build/windows-window-events/assets");
  const childReport = resolve(
    childRoot,
    "build/windows-window-events/report.json",
  );
  let documents = 0;
  let denied = false;
  const ids: string[] = [];
  const records: {
    windowId: string;
    revision: number;
    changes: string[];
  }[] = [];
  async function waitFor(check: () => boolean) {
    const deadline = Date.now() + 10000;
    while (!check()) {
      assert(Date.now() < deadline, "Window event did not arrive");
      await Bun.sleep(5);
    }
  }
  const app = defineApp({
    modules: [],
    plugins: [
      windowsPlugin,
    ],
    commands: {
      "test.record": {
        input: windowEvents["windows.changed"],
        output: {
          const: null,
        },
        async run(input: unknown) {
          const event = validateValue(windowEvents["windows.changed"], input);
          records.push(event);
          return null;
        },
      },
      "test.denied": {
        ...noInput,
        async run() {
          denied = true;
          return null;
        },
      },
      "test.exercise": {
        input: {
          const: null,
        },
        output: {
          type: "object",
          properties: {
            phase: {
              type: "integer",
            },
            snapshot: windowSnapshotSchema,
          },
          required: [
            "phase",
            "snapshot",
          ],
          additionalProperties: false,
        },
        async run() {
          documents++;
          const before = await windows.getSnapshot(target);
          ids.push(before.windowId);
          const start = records.length;
          await windows.hide(target);
          await windows.show(target);
          await windows.setPosition({
            ...target,
            x: 50 + documents * 20,
            y: 60,
          });
          await windows.setSize({
            ...target,
            width: 650 + documents * 20,
            height: 500,
          });
          await windows.maximize(target);
          await windows.unmaximize(target);
          await windows.minimize(target);
          await windows.restore(target);
          await windows.setFullscreen({
            ...target,
            fullscreen: true,
          });
          await windows.setFullscreen({
            ...target,
            fullscreen: false,
          });
          const expected = [
            "hidden",
            "shown",
            "move",
            "resize",
            "maximize",
            "unmaximize",
            "minimize",
            "restore",
            "enterFullscreen",
            "leaveFullscreen",
          ];
          await waitFor(() =>
            expected.every((change) =>
              records
                .slice(start)
                .some((record) => record.changes.includes(change)),
            ),
          );
          const snapshot = await windows.getSnapshot(target);
          assert.deepEqual(
            snapshot.bounds,
            await windows.getOuterBounds(target),
          );
          const current = records.slice(start);
          assert(
            current.every((event) => event.windowId === snapshot.windowId),
          );
          for (let index = 1; index < current.length; index++) {
            assert(
              (current[index]?.revision ?? 0) >
                (current[index - 1]?.revision ?? 0),
            );
          }
          return {
            phase: documents,
            snapshot,
          };
        },
      },
      "test.unsubscribed": {
        ...noInput,
        async run() {
          const count = records.length;
          await windows.setPosition({
            ...target,
            x: 180,
            y: 90,
          });
          await Bun.sleep(100);
          assert.equal(
            records.length,
            count,
            "Released listener received an event",
          );
          return null;
        },
      },
      "test.recreate": {
        ...noInput,
        async run() {
          await windows.recreate(target);
          return null;
        },
      },
      "test.finish": {
        ...noInput,
        async run() {
          await waitFor(() => denied);
          assert.equal(ids[0], ids[1], "Navigation changed native identity");
          assert.notEqual(
            ids[1],
            ids[2],
            "Recreation retained native identity",
          );
          await writeFile(
            childReport,
            JSON.stringify({
              pass: true,
              documents,
              denied,
              records: records.length,
              ids,
            }),
          );
          await windows.close({
            view: "denied",
          });
          await windows.close(target);
          return null;
        },
      },
    },
  });
  await runWindowsApp(app, {
    runtime: {
      id: "window-events",
      generation: crypto.randomUUID(),
    },
    backendContext: `backend-${crypto.randomUUID()}` as HostContext,
    policy,
    assets: childAssets,
    dataRoot: resolve(
      childRoot,
      `build/windows-window-events/data-${process.pid}`,
    ),
    loader: resolve(
      childRoot,
      "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
    ),
    windows: [
      "main",
      "denied",
    ].map((view) => ({
      view,
      title: `Events ${view}`,
      home: `https://app.bunaway.local/${view === "main" ? "index" : "denied"}.html`,
      window: {
        width: 640,
        height: 480,
      },
    })),
  });
}
