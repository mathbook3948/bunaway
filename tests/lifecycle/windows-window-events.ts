import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineApp } from "@bunaway/backend";
import windows, {
  windowEvents,
  windowSnapshotSchema,
} from "@bunaway/plugin-windows";
import {
  type HostContext,
  type Policy,
  validateValue,
} from "@bunaway/protocol";
import { runWindowsApp } from "#native/windows/bun/entry";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";
import { windowPermissions } from "../fixtures/window-permissions.ts";

assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-window-events");
const assets = resolve(output, "assets");
const reportPath = resolve(output, "report.json");
const target = {
  view: "main",
};
const grants = windowPermissions();
const policy: Policy = {
  version: 1,
  backend: {
    permissions: [
      ...grants,
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
              ...grants,
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
    assert.equal(report.onceDocuments, 3);
    console.log(
      "PASS WebView2 native events: delivery, once, cancellation, permission denial, snapshot recovery, unlisten, navigation, recreation, shutdown",
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
  let onceDocuments = 0;
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
      windows,
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
          assert.equal(await windows.activate(target), false);
          await windows.showInactive(target);
          assert.equal(await windows.isVisible(target), true);
          const activated = await windows.activate(target);
          assert.equal(activated, await windows.isFocused(target));
          const blurred = await windows.blur(target);
          assert.equal(blurred, !(await windows.isFocused(target)));
          const driver = dlopen("user32.dll", {
            FindWindowW: {
              args: [
                "ptr",
                "ptr",
              ],
              returns: "u64",
            },
            SendMessageW: {
              args: [
                "u64",
                "u32",
                "u64",
                "i64",
              ],
              returns: "i64",
            },
          });
          const caption = Buffer.from("Events main\0", "utf16le");
          const hwnd = driver.symbols.FindWindowW(null, ptr(caption));
          assert(hwnd);
          const contentBefore = await windows.getContentSize({
            ...target,
            unit: "logical",
          });
          try {
            // Native begin/end messages surround public geometry calls; final events travel
            // through the actual UI owner, Core session and subscribed WebView document.
            driver.symbols.SendMessageW(hwnd, 0x0231, 0n, 0n);
            await windows.setPosition({
              ...target,
              x: before.bounds.x + 31,
              y: before.bounds.y + 29,
            });
            await windows.setSize({
              ...target,
              width: contentBefore.width + 10,
              height: contentBefore.height + 10,
            });
          } finally {
            driver.symbols.SendMessageW(hwnd, 0x0232, 0n, 0n);
            driver.close();
          }
          // Exercise setters through the public SDK, Core, UI worker and WebView2 events.
          const content = await windows.getContentBounds(target);
          await windows.setContentPosition({
            ...target,
            x: content.x + 13,
            y: content.y + 17,
          });
          assert.deepEqual(
            {
              ...(await windows.getContentPosition(target)),
            },
            {
              x: content.x + 13,
              y: content.y + 17,
              dpi: content.dpi,
            },
          );
          const outer = await windows.getOuterBounds(target);
          await windows.setOuterSize({
            ...target,
            width: outer.width + 9,
            height: outer.height + 11,
          });
          await windows.setContentBounds({
            ...target,
            x: 100,
            y: 110,
            width: 700,
            height: 520,
            unit: "logical",
          });
          const logical = await windows.getContentBounds({
            ...target,
            unit: "logical",
          });
          assert.deepEqual(
            {
              ...logical,
            },
            {
              x: 100,
              y: 110,
              width: 700,
              height: 520,
              dpi: logical.dpi,
            },
          );
          const desired = {
            x: 140,
            y: 150,
            width: outer.width + 20,
            height: outer.height + 20,
          };
          const beforeBounds = records.length;
          await windows.setOuterBounds({
            ...target,
            ...desired,
          });
          const applied = await windows.getSnapshot(target);
          assert.deepEqual(
            {
              ...applied.bounds,
            },
            {
              ...desired,
              dpi: applied.bounds.dpi,
            },
          );
          await waitFor(() =>
            records
              .slice(beforeBounds)
              .some(
                (record) =>
                  record.windowId === applied.windowId &&
                  record.revision === applied.revision,
              ),
          );
          assert.deepEqual(
            {
              ...records.find(
                (record) =>
                  record.windowId === applied.windowId &&
                  record.revision === applied.revision,
              ),
            },
            {
              ...applied,
              changes: [
                "move",
                "resize",
              ],
            },
          );
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
          await windows.setAlwaysOnTop({
            ...target,
            alwaysOnTop: true,
          });
          await windows.setAlwaysOnTop({
            ...target,
            alwaysOnTop: false,
          });
          const expected = [
            "hidden",
            "shown",
            "move",
            "resize",
            "moved",
            "resized",
            "maximize",
            "unmaximize",
            "minimize",
            "restore",
            "enterFullscreen",
            "leaveFullscreen",
            "enterAlwaysOnTop",
            "leaveAlwaysOnTop",
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
        input: {
          type: "object",
          properties: {
            onceCount: {
              const: 1,
            },
            onceSequence: {
              const: 1,
            },
            onceWindowId: {
              type: "string",
            },
            cancelledDeliveries: {
              const: 0,
            },
          },
          required: [
            "onceCount",
            "onceSequence",
            "onceWindowId",
            "cancelledDeliveries",
          ],
          additionalProperties: false,
        },
        output: {
          const: null,
        },
        async run(input: { onceWindowId: string }) {
          assert.equal(
            input.onceWindowId,
            (await windows.getSnapshot(target)).windowId,
          );
          onceDocuments++;
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
              onceDocuments,
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
