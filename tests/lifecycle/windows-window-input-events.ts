import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-window-input-events");
const assets = resolve(output, "assets");
const reportPath = resolve(output, "report.json");
const target = {
  view: "main",
};
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
        "test.exercise",
        "test.record",
        "test.finish",
      ],
      events: [
        "windows.appCommand",
        "windows.systemContextMenu",
      ],
      host: {
        permissions: [],
      },
    },
  ],
};
const noInput = {
  input: {
    const: null,
  },
  output: {
    const: null,
  },
} as const;
const WM_CONTEXTMENU = 0x007b;
const WM_CANCELMODE = 0x001f;
const WM_APPCOMMAND = 0x0319;
const FAPPCOMMAND_MOUSE = 0x8000;

if (!process.argv.includes("--child")) {
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  await writeFile(
    resolve(assets, "web/index.html"),
    '<!doctype html><title>Input events</title><script type="module" src="/events.js"></script>',
  );
  const web = await Bun.build({
    entrypoints: [
      resolve(root, "tests/lifecycle/windows-bun/window-input-events.js"),
    ],
    target: "browser",
  });
  assert(web.success, web.logs.map(String).join("\n"));
  for (const artifact of web.outputs) {
    await writeFile(resolve(assets, "web/events.js"), await artifact.text());
  }
  const entry = await bundleNativeWorker(
    "windows-window-input-events",
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
  const timeout = killAfter(child, "nativeFixture");
  try {
    const code = await child.exited;
    assert.equal(code, 0, `${await stderr}\n${await stdout}`);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.pass, true);
    console.log(
      "PASS WebView2 window input events: app commands, title bar context menu, ignored codes and areas",
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
  const childAssets = resolve(
    childRoot,
    "build/windows-window-input-events/assets",
  );
  const childReport = resolve(
    childRoot,
    "build/windows-window-input-events/report.json",
  );
  const records: {
    event: string;
    payload: Record<string, unknown>;
  }[] = [];
  const app = defineApp({
    modules: [],
    plugins: [
      windows,
    ],
    commands: {
      "test.record": {
        input: {
          type: "object",
        },
        output: {
          const: null,
        },
        async run(input: unknown) {
          records.push(input as (typeof records)[number]);
          return null;
        },
      },
      "test.exercise": {
        ...noInput,
        async run() {
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
            PostMessageW: {
              args: [
                "u64",
                "u32",
                "u64",
                "i64",
              ],
              returns: "i32",
            },
            GetWindowRect: {
              args: [
                "u64",
                "ptr",
              ],
              returns: "i32",
            },
          });
          try {
            const caption = Buffer.from("Input main\0", "utf16le");
            const hwnd = driver.symbols.FindWindowW(null, ptr(caption));
            assert(hwnd);
            const snapshot = await windows.getSnapshot(target);
            const rect = Buffer.alloc(16);
            assert(driver.symbols.GetWindowRect(hwnd, ptr(rect)));
            const left = rect.readInt32LE(0);
            const top = rect.readInt32LE(4);
            const width = rect.readInt32LE(8) - left;
            const height = rect.readInt32LE(12) - top;
            const point = (x: number, y: number) =>
              BigInt.asIntN(64, BigInt(((y & 0xffff) << 16) | (x & 0xffff)));
            const appCommand = (code: number, device = FAPPCOMMAND_MOUSE) =>
              driver.symbols.SendMessageW(
                hwnd,
                WM_APPCOMMAND,
                hwnd,
                BigInt((device | code) * 0x10000),
              );
            // Context menu messages are posted: the default handling of a title bar click opens the
            // system menu, whose modal loop would otherwise hold the sender. WM_CANCELMODE closes it.
            const contextMenu = async (lparam: bigint, wparam = hwnd) => {
              driver.symbols.PostMessageW(hwnd, WM_CONTEXTMENU, wparam, lparam);
              await Bun.sleep(100);
              driver.symbols.SendMessageW(hwnd, WM_CANCELMODE, 0n, 0n);
            };
            const centerX = left + Math.floor(width / 2);

            // Ignored input first: unknown codes, the client area, keyboard invocation and a
            // pointer over a child window. Event order guarantees these came before the sentinel.
            appCommand(43);
            appCommand(0xfff);
            await contextMenu(point(centerX, top + Math.floor(height / 2)));
            await contextMenu(-1n);
            await contextMenu(point(centerX, top + 16), hwnd + 1n);

            appCommand(1);
            appCommand(14, 0);
            await waitFor(
              () =>
                records.some(
                  (record) =>
                    record.event === "windows.appCommand" &&
                    record.payload.command === "media-play-pause",
                ),
              {
                deadline: "childStep",
                what: "the app command events",
              },
            );
            const commands = records
              .filter((record) => record.event === "windows.appCommand")
              .map((record) => record.payload.command);
            assert.deepEqual(commands, [
              "browser-backward",
              "media-play-pause",
            ]);
            assert.equal(
              records.filter(
                (record) => record.event === "windows.systemContextMenu",
              ).length,
              0,
              "Client, keyboard or child-window menus must not publish",
            );

            const y = top + 16;
            await contextMenu(point(centerX, y));
            await waitFor(
              () =>
                records.some(
                  (record) => record.event === "windows.systemContextMenu",
                ),
              {
                deadline: "childStep",
                what: "the system context menu event",
              },
            );
            const menu = records.find(
              (record) => record.event === "windows.systemContextMenu",
            );
            assert.deepEqual(menu?.payload, {
              windowId: snapshot.windowId,
              viewId: "main",
              x: centerX,
              y,
            });
            for (const record of records) {
              assert.equal(record.payload.windowId, snapshot.windowId);
            }
          } finally {
            driver.close();
          }
          return null;
        },
      },
      "test.finish": {
        ...noInput,
        async run() {
          await writeFile(
            childReport,
            JSON.stringify({
              pass: true,
              records: records.length,
            }),
          );
          await windows.close(target);
          return null;
        },
      },
    },
  });
  await runWindowsApp(app, {
    appMetadata: testAppMetadata,
    runtime: {
      id: "window-input-events",
      generation: crypto.randomUUID(),
    },
    backendContext: `backend-${crypto.randomUUID()}` as HostContext,
    policy,
    assets: childAssets,
    dataRoot: resolve(
      childRoot,
      `build/windows-window-input-events/data-${process.pid}`,
    ),
    loader: resolve(
      childRoot,
      "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
    ),
    windows: [
      {
        view: "main",
        title: "Input main",
        home: "https://app.bunaway.local/index.html",
        window: {
          width: 640,
          height: 480,
        },
      },
    ],
  });
}
