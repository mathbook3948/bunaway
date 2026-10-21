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
import { trayIco } from "../fixtures/tray-icon.ts";
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
        "windows.thumbnailToolbarClicked",
      ],
      host: {
        permissions: [
          ...windowPermissions(),
        ],
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
const WM_NCHITTEST = 0x0084;
const HTCAPTION = 2;
const CANCEL_ATTEMPTS = 5;
const CANCEL_INTERVAL_MS = 50;
const WM_APPCOMMAND = 0x0319;
const WM_COMMAND = 0x0111;
const THBN_CLICKED = 0x1800;
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
      "PASS WebView2 window input events: app commands, title bar context menu, thumbnail toolbar presses, ignored codes and areas",
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
            // Everything is posted so the window sees one ordered queue: an ignored message is
            // always handled before the sentinel that follows it.
            const appCommand = (code: number, device = FAPPCOMMAND_MOUSE) =>
              driver.symbols.PostMessageW(
                hwnd,
                WM_APPCOMMAND,
                hwnd,
                BigInt((device | code) * 0x10000),
              );
            const contextMenu = (lparam: bigint, wparam = hwnd) =>
              driver.symbols.PostMessageW(hwnd, WM_CONTEXTMENU, wparam, lparam);
            const centerX = left + Math.floor(width / 2);
            const y = top + 16;
            // The published point must be a title bar hit for this window's frame and theme.
            const hit = driver.symbols.SendMessageW(
              hwnd,
              WM_NCHITTEST,
              0n,
              point(centerX, y),
            );
            assert.equal(BigInt.asIntN(32, hit), BigInt(HTCAPTION));

            // Ignored input first: unknown codes, the client area, keyboard invocation and a
            // pointer over the client area.
            appCommand(43);
            appCommand(0xfff);
            contextMenu(point(centerX, top + Math.floor(height / 2)));
            contextMenu(-1n);
            // A caption point with another window in wparam would open the default system menu
            // without publishing, and its modal loop would hold the later messages.

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

            // The default handling of a title bar click opens the system menu and its modal loop;
            // WM_CANCELMODE closes it once the event has arrived.
            contextMenu(point(centerX, y));
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
            assert.deepEqual(
              {
                ...menu?.payload,
              },
              {
                windowId: snapshot.windowId,
                viewId: "main",
                x: centerX,
                y,
              },
            );
            for (const record of records) {
              assert.equal(record.payload.windowId, snapshot.windowId);
            }
            // The menu may open just after the event left the window procedure, so cancel a few times.
            for (let attempt = 0; attempt < CANCEL_ATTEMPTS; attempt++) {
              driver.symbols.SendMessageW(hwnd, WM_CANCELMODE, 0n, 0n);
              await Bun.sleep(CANCEL_INTERVAL_MS);
            }

            // Thumbnail toolbar presses arrive as WM_COMMAND with THBN_CLICKED; the host maps the slot
            // to the app's button id and drops everything it did not register or that is not pressable.
            const toolbarIco = trayIco().toString("base64");
            await waitFor(
              async () => {
                try {
                  await windows.setThumbnailToolbar({
                    ...target,
                    buttons: [
                      {
                        id: "play",
                        ico: toolbarIco,
                        tooltip: "Play",
                      },
                      {
                        id: "off",
                        ico: toolbarIco,
                        flags: [
                          "disabled",
                        ],
                      },
                      {
                        id: "gone",
                        ico: toolbarIco,
                        flags: [
                          "hidden",
                        ],
                      },
                      {
                        id: "next",
                        ico: toolbarIco,
                        flags: [
                          "dismissonclick",
                        ],
                      },
                    ],
                  });
                  return true;
                } catch (error) {
                  // Explorer creates the taskbar button asynchronously.
                  if (
                    error instanceof Error &&
                    "code" in error &&
                    error.code === "BUSY"
                  ) {
                    return false;
                  }
                  throw error;
                }
              },
              {
                deadline: "childStep",
                what: "the taskbar button for the thumbnail toolbar",
              },
            );
            const press = (slot: number, notification = THBN_CLICKED) =>
              driver.symbols.PostMessageW(
                hwnd,
                WM_COMMAND,
                BigInt((notification << 16) | slot),
                0n,
              );
            const pressed = () =>
              records
                .filter(
                  (record) =>
                    record.event === "windows.thumbnailToolbarClicked",
                )
                .map((record) => record.payload.buttonId);
            // Disabled, hidden and unregistered slots, a menu command and an out-of-range slot first.
            press(1);
            press(2);
            press(4);
            press(0xffff);
            press(0, 0);
            press(0);
            press(3);
            await waitFor(() => pressed().length >= 2, {
              deadline: "childStep",
              what: "the thumbnail toolbar click events",
            });
            assert.deepEqual(pressed(), [
              "play",
              "next",
            ]);
            // A shorter toolbar hides the remaining slots, so their old presses are ignored. The app
            // command that follows proves the earlier message was handled without publishing.
            await windows.setThumbnailToolbar({
              ...target,
              buttons: [
                {
                  id: "solo",
                  ico: toolbarIco,
                },
              ],
            });
            press(3);
            press(0);
            appCommand(2, 0);
            await waitFor(
              () =>
                records.some(
                  (record) =>
                    record.event === "windows.appCommand" &&
                    record.payload.command === "browser-forward",
                ),
              {
                deadline: "childStep",
                what: "the app command after the toolbar change",
              },
            );
            assert.deepEqual(pressed(), [
              "play",
              "next",
              "solo",
            ]);
            await windows.setThumbnailToolbar({
              ...target,
              buttons: [],
            });
            press(0);
            appCommand(3, 0);
            await waitFor(
              () =>
                records.some(
                  (record) =>
                    record.event === "windows.appCommand" &&
                    record.payload.command === "browser-refresh",
                ),
              {
                deadline: "childStep",
                what: "the app command after the toolbar was emptied",
              },
            );
            assert.equal(pressed().length, 3);
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
