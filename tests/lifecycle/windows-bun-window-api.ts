import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runWindowsApp } from "../../native/windows/bun/entry.ts";
import { user } from "../../native/windows/bun/win32-bindings.ts";
import { Windows } from "../../native/windows/bun/win32.ts";
import {
  type CommandContext,
  defineApp,
} from "../../packages/backend-sdk/src/index.ts";
import type { HostContext, Policy } from "../../packages/protocol/src/index.ts";
import { windows, windowsPlugin } from "../../plugins/windows/src/index.ts";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";

assert.equal(process.platform, "win32");
const root = process.argv.includes("--repo")
  ? (process.argv[process.argv.indexOf("--repo") + 1] ?? "")
  : resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-window-api");
const assets = resolve(output, "assets");
const reportPath = resolve(output, "report.json");
const policy: Policy = {
  version: 1,
  backend: {
    permissions: [
      "windows:list",
      {
        identifier: "windows:control",
        allow: [
          {
            view: "main",
          },
          {
            view: "editor",
          },
        ],
      },
    ],
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
        permissions: [
          "windows:list",
          {
            identifier: "windows:control",
            allow: [
              {
                view: "main",
              },
              {
                view: "editor",
              },
            ],
          },
        ],
      },
    },
    {
      id: "editor",
      origins: [
        "https://app.bunaway.local",
      ],
      commands: [
        "test.aux",
        "test.hold",
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
  const built = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "windows-bun/window-api.js"),
    ],
    target: "browser",
  });
  assert(built.success && built.outputs[0]);
  await writeFile(
    resolve(assets, "web/app.js"),
    new Uint8Array(await built.outputs[0].arrayBuffer()),
  );
  for (const name of [
    "index.html",
    "editor.html",
  ]) {
    await writeFile(
      resolve(assets, "web", name),
      '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'"><script type="module" src="app.js"></script>',
    );
  }
  const driver = dlopen("user32.dll", {
    FindWindowW: {
      args: [
        "ptr",
        "ptr",
      ],
      returns: "u64",
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
    GetClientRect: {
      args: [
        "u64",
        "ptr",
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
    IsWindowVisible: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
    IsIconic: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
    IsZoomed: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
    GetDpiForWindow: {
      args: [
        "u64",
      ],
      returns: "u32",
    },
    ShowWindow: {
      args: [
        "u64",
        "i32",
      ],
      returns: "i32",
    },
  });
  const nativeWindows = new Windows(() => {});
  try {
    for (const showCmd of [
      1,
      2,
      3,
    ]) {
      for (const visible of [
        true,
        false,
      ]) {
        const hwnd = nativeWindows.create(
          "Fullscreen visibility regression",
          800,
          600,
          () => {},
        );
        try {
          user.symbols.ShowWindow(hwnd, showCmd);
          if (!visible) {
            nativeWindows.show(hwnd, false);
          }
          const frame = new Int32Array(4),
            restored = new Int32Array(4);
          assert(driver.symbols.GetWindowRect(hwnd, ptr(frame)));
          const minimized = driver.symbols.IsIconic(hwnd),
            maximized = driver.symbols.IsZoomed(hwnd);
          nativeWindows.setFullscreen(hwnd, true);
          nativeWindows.setFullscreen(hwnd, false);
          assert.equal(driver.symbols.IsWindowVisible(hwnd), Number(visible));
          assert.equal(driver.symbols.IsIconic(hwnd), minimized);
          assert.equal(driver.symbols.IsZoomed(hwnd), maximized);
          assert(driver.symbols.GetWindowRect(hwnd, ptr(restored)));
          assert.deepEqual(
            [
              ...restored,
            ],
            [
              ...frame,
            ],
            `Fullscreen restore showCmd=${showCmd}, visible=${visible}`,
          );
        } finally {
          nativeWindows.destroy(hwnd);
        }
      }
    }
  } finally {
    nativeWindows.dispose();
  }
  const childEntry = await bundleNativeWorker(
    "windows-bun-window-api",
    resolve(output, "driver"),
    import.meta.path,
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      fileURLToPath(childEntry),
      "--child",
      "--repo",
      root,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const handles = new Map<string, bigint>();
  const dialogClass = Buffer.from("#32770\0", "utf16le");
  const dialogTitle = Buffer.from("Window API editor\0", "utf16le");
  let confirmations = 0,
    editorWindows = 0,
    geometry = false,
    pending = "";
  const windowChecks: Promise<void>[] = [];
  const decoder = new TextDecoder();
  const timers = new Set<ReturnType<typeof setInterval>>();
  let editorBrowser = 0;
  const crashes: Promise<void>[] = [];
  function assertClientSize(hwnd: bigint, width: number, height: number) {
    const client = new Int32Array(4);
    assert(driver.symbols.GetClientRect(hwnd, ptr(client)));
    const dpi = driver.symbols.GetDpiForWindow(hwnd);
    const physical = (logical: number) => Math.round((logical * dpi) / 96);
    assert.deepEqual(
      [
        client[2],
        client[3],
      ],
      [
        physical(width),
        physical(height),
      ],
    );
  }
  async function testMaximizeRestore(hwnd: bigint) {
    const deadline = Date.now() + 5000;
    driver.symbols.ShowWindow(hwnd, 3);
    while (!driver.symbols.IsZoomed(hwnd)) {
      assert(Date.now() < deadline, "Window did not maximize.");
      await Bun.sleep(10);
    }
    const client = new Int32Array(4);
    assert(driver.symbols.GetClientRect(hwnd, ptr(client)));
    const dpi = driver.symbols.GetDpiForWindow(hwnd);
    const toLogical = (physical: number) => Math.round((physical * 96) / dpi);
    const width = toLogical(client[2] ?? 0);
    const height = toLogical(client[3] ?? 0);
    assert(width >= 950);
    assert(width <= 1100);
    assert(height >= 500);
    assert(height <= 800);
    driver.symbols.ShowWindow(hwnd, 9);
    while (driver.symbols.IsZoomed(hwnd)) {
      assert(Date.now() < deadline, "Window did not restore.");
      await Bun.sleep(10);
    }
    assertClientSize(hwnd, 950, 650);
  }
  const previousDpiContext = user.symbols.SetThreadDpiAwarenessContext(-4n);
  assert(previousDpiContext);
  const stdout = child.stdout.pipeTo(
    new WritableStream({
      write(chunk) {
        pending += decoder.decode(chunk, {
          stream: true,
        });
        while (pending.includes("\n")) {
          const end = pending.indexOf("\n");
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (!line) {
            continue;
          }
          const event = JSON.parse(line);
          if (event.event === "webview-ready" && event.view === "editor") {
            editorBrowser = event.browserPid;
          }
          if (event.event === "window-api-browser-crash") {
            assert(editorBrowser);
            const killer = Bun.spawn(
              [
                "taskkill",
                "/F",
                "/PID",
                String(editorBrowser),
              ],
              {
                stdout: "ignore",
                stderr: "ignore",
              },
            );
            crashes.push(killer.exited.then((code) => assert.equal(code, 0)));
          }
          if (event.event === "window-created") {
            handles.set(event.view, BigInt(event.hwnd));
            if (event.view === "editor" && ++editorWindows > 4) {
              child.kill();
              throw new Error("Revoked creation reopened the editor window.");
            }
          }
          if (event.event === "window-api-geometry") {
            const hwnd = handles.get("editor");
            assert(hwnd);
            const frame = new Int32Array(4);
            assertClientSize(hwnd, 950, 650);
            assert(driver.symbols.GetWindowRect(hwnd, ptr(frame)));
            assert.equal(frame[0], 20);
            assert.equal(frame[1], 30);
            geometry = true;
            windowChecks.push(
              testMaximizeRestore(hwnd).catch((error) => {
                child.kill();
                throw error;
              }),
            );
          }
          if (event.event === "window-api-constrained-size") {
            const hwnd = handles.get("editor");
            assert(hwnd);
            assertClientSize(hwnd, event.width, event.height);
          }
          if (event.event === "window-api-initial-size") {
            const hwnd = handles.get("editor");
            assert(hwnd);
            assertClientSize(hwnd, 500, 900);
          }
          if (event.event === "window-close-confirmation") {
            const answer = ++confirmations === 1 ? 7n : 6n; // IDNO then IDYES
            const deadline = Date.now() + 10000;
            const timer = setInterval(() => {
              const hwnd = driver.symbols.FindWindowW(
                ptr(dialogClass),
                ptr(dialogTitle),
              );
              if (hwnd) {
                assert(driver.symbols.PostMessageW(hwnd, 0x111, answer, 0n));
                clearInterval(timer);
                timers.delete(timer);
              } else if (Date.now() > deadline) {
                clearInterval(timer);
                timers.delete(timer);
                child.kill();
              }
            }, 10);
            timers.add(timer);
          }
        }
      },
    }),
  );
  const errors = new Response(child.stderr).text();
  const timeout = setTimeout(() => child.kill(), 150000);
  try {
    const code = await child.exited;
    await stdout;
    await Promise.all(crashes);
    await Promise.all(windowChecks);
    assert.equal(code, 0, await errors);
    assert.equal(confirmations, 2);
    assert.equal(crashes.length, 1);
    assert(geometry);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.pass, true);
    assert.equal(report.auxiliaryDocuments, 4);
    assert.equal(editorWindows, 4);
    assert.equal(report.cancelledCreation, true);
    assert.equal(report.browserFailureClosed, true);
    console.log(
      "PASS Windows public window API: size constraints, GetDpiForWindow scaling at the current monitor, maximize and restore, fullscreen visibility, geometry, close refusal, browser failure, dynamic creation, fresh sessions and revoked creation",
    );
  } finally {
    clearTimeout(timeout);
    for (const timer of timers) {
      clearInterval(timer);
    }
    if (child.exitCode === null) {
      child.kill();
    }
    await child.exited;
    assert(user.symbols.SetThreadDpiAwarenessContext(previousDpiContext));
    driver.close();
  }
} else {
  let runs = 0,
    auxiliaryDocuments = 0,
    holds = 0,
    cancellations = 0,
    quitAttempts = 0;
  async function waitFor(check: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 10000;
    while (!(await check())) {
      assert(Date.now() < deadline, "Fresh document did not connect");
      await Bun.sleep(10);
    }
  }
  const contract = {
    input: {
      const: null,
    },
    output: {
      const: null,
    },
  } as const;
  const app = defineApp({
    modules: [],
    plugins: [
      windowsPlugin,
    ],
    desktop: {
      beforeQuit: () => ++quitAttempts > 1,
    },
    commands: {
      "test.aux": {
        ...contract,
        async run(_input: unknown, _context: CommandContext) {
          await assert.rejects(
            windows.show({
              view: "main",
            }),
            (error: unknown) =>
              (
                error as {
                  code: string;
                }
              ).code === "PERMISSION_DENIED",
          );
          await assert.rejects(
            windows.getSizeConstraints({
              view: "main",
            }),
            (error: unknown) =>
              (
                error as {
                  code: string;
                }
              ).code === "PERMISSION_DENIED",
          );
          auxiliaryDocuments++;
          return null;
        },
      },
      "test.hold": {
        ...contract,
        async run(_input: unknown, context: CommandContext) {
          holds++;
          return new Promise<null>((_resolve, reject) =>
            context.signal.addEventListener("abort", () => {
              cancellations++;
              reject(new Error("old document revoked"));
            }),
          );
        },
      },
      "test.run": {
        ...contract,
        async run() {
          if (++runs === 1) {
            await windows.create({
              view: "editor",
            });
            assert.deepEqual(
              {
                ...(await windows.getSizeConstraints({
                  view: "editor",
                })),
              },
              {
                minWidth: 500,
                minHeight: 400,
                maxWidth: 1200,
                maxHeight: 900,
              },
            );
            assert.deepEqual(
              {
                ...(await windows.getMinSize({
                  view: "editor",
                })),
              },
              {
                width: 500,
                height: 400,
              },
            );
            assert.deepEqual(
              {
                ...(await windows.getMaxSize({
                  view: "editor",
                })),
              },
              {
                width: 1200,
                height: 900,
              },
            );
            console.log(
              JSON.stringify({
                event: "window-api-initial-size",
              }),
            );
            await waitFor(() => holds === 1);
            await assert.rejects(
              windows.create({
                view: "editor",
              }),
              (error: unknown) =>
                (
                  error as {
                    code: string;
                  }
                ).code === "BUSY",
            );
            await windows.hide({
              view: "editor",
            });
            await windows.show({
              view: "editor",
            });
            try {
              await windows.focus({
                view: "editor",
              });
            } catch (error) {
              assert.equal(
                (
                  error as {
                    code: string;
                  }
                ).code,
                "BUSY",
              );
            }
            await windows.setSize({
              view: "editor",
              width: 900,
              height: 650,
            });
            await windows.setPosition({
              view: "editor",
              x: 20,
              y: 30,
            });
            await windows.setSize({
              view: "editor",
              width: 300,
              height: 300,
            });
            console.log(
              JSON.stringify({
                event: "window-api-constrained-size",
                width: 500,
                height: 400,
              }),
            );
            await windows.setSize({
              view: "editor",
              width: 1400,
              height: 1000,
            });
            console.log(
              JSON.stringify({
                event: "window-api-constrained-size",
                width: 1200,
                height: 900,
              }),
            );
            await windows.setSizeConstraints({
              view: "editor",
              minWidth: 600,
              maxWidth: 1100,
              maxHeight: 800,
            });
            console.log(
              JSON.stringify({
                event: "window-api-constrained-size",
                width: 1100,
                height: 800,
              }),
            );
            await windows.setMinSize({
              view: "editor",
              width: 700,
              height: null,
            });
            assert.deepEqual(
              {
                ...(await windows.getSizeConstraints({
                  view: "editor",
                })),
              },
              {
                minWidth: 700,
                minHeight: null,
                maxWidth: 1100,
                maxHeight: 800,
              },
            );
            const beforeInvalid = await windows.getSizeConstraints({
              view: "editor",
            });
            await assert.rejects(
              windows.setMaxSize({
                view: "editor",
                width: 699,
                height: null,
              }),
              (error: unknown) =>
                (
                  error as {
                    code: string;
                  }
                ).code === "INVALID_ARGUMENT",
            );
            assert.deepEqual(
              {
                ...(await windows.getSizeConstraints({
                  view: "editor",
                })),
              },
              {
                ...beforeInvalid,
              },
            );
            await windows.setSizeConstraints({
              view: "editor",
              minHeight: 350,
            });
            assert.deepEqual(
              {
                ...(await windows.getSizeConstraints({
                  view: "editor",
                })),
              },
              {
                minWidth: null,
                minHeight: 350,
                maxWidth: null,
                maxHeight: null,
              },
            );
            await windows.setMinSize({
              view: "editor",
              width: null,
              height: null,
            });
            await windows.setMaxSize({
              view: "editor",
              width: null,
              height: null,
            });
            assert.deepEqual(
              {
                ...(await windows.getSizeConstraints({
                  view: "editor",
                })),
              },
              {
                minWidth: null,
                minHeight: null,
                maxWidth: null,
                maxHeight: null,
              },
            );
            await windows.setSize({
              view: "editor",
              width: 900,
              height: 650,
            });
            await windows.setSizeConstraints({
              view: "editor",
              minWidth: 800,
              minHeight: 500,
              maxWidth: 1000,
              maxHeight: 800,
            });
            await windows.setFullscreen({
              view: "editor",
              fullscreen: true,
            });
            await assert.rejects(
              windows.setSize({
                view: "editor",
                width: 800,
                height: 600,
              }),
              (error: unknown) =>
                (
                  error as {
                    code: string;
                  }
                ).code === "INVALID_ARGUMENT",
            );
            await windows.setSizeConstraints({
              view: "editor",
              minWidth: 950,
              minHeight: 500,
              maxWidth: 1100,
              maxHeight: 800,
            });
            assert.deepEqual(
              {
                ...(await windows.getSizeConstraints({
                  view: "editor",
                })),
              },
              {
                minWidth: 950,
                minHeight: 500,
                maxWidth: 1100,
                maxHeight: 800,
              },
            );
            await windows.setFullscreen({
              view: "editor",
              fullscreen: false,
            });
            console.log(
              JSON.stringify({
                event: "window-api-constrained-size",
                width: 950,
                height: 650,
              }),
            );
            console.log(
              JSON.stringify({
                event: "window-api-geometry",
              }),
            );
            await windows.setCloseConfirmation({
              view: "editor",
              message: "Close editor?",
            });
            assert.equal(
              await windows.close({
                view: "editor",
              }),
              false,
            );
            assert(
              (await windows.list()).find((spec) => spec.view === "editor")
                ?.open,
            );
            await windows.recreate({
              view: "editor",
            });
            await waitFor(() => holds === 2 && cancellations === 1);
          } else if (runs === 2) {
            assert.deepEqual(
              {
                ...(await windows.getSizeConstraints({
                  view: "editor",
                })),
              },
              {
                minWidth: 500,
                minHeight: 400,
                maxWidth: 1200,
                maxHeight: 900,
              },
            );
            assert.equal(
              await windows.close({
                view: "editor",
              }),
              true,
            ); // confirmation resets on recreation
            await windows.create({
              view: "editor",
            });
            await waitFor(() => holds === 3 && cancellations === 2);
          } else if (runs === 3) {
            await windows.setCloseConfirmation({
              view: "editor",
              message: "Close editor?",
            });
            console.log(
              JSON.stringify({
                event: "window-api-browser-crash",
              }),
            );
            await waitFor(async () =>
              (await windows.list()).some(
                (spec) => spec.view === "editor" && !spec.open,
              ),
            );
            await waitFor(() => cancellations === 3);
            await windows.recreate({
              view: "main",
            }); // revokes this caller, but replacement must finish
          } else {
            assert.equal(runs, 4);
            assert.equal(
              quitAttempts,
              0,
              "recreation must bypass app quit checks",
            );
            await Bun.sleep(50); // let the replacement readiness reply release its reservation
            await windows.create({
              view: "editor",
            });
            await waitFor(() => holds === 4);
            assert.equal(
              await windows.close({
                view: "editor",
              }),
              true,
            );
            assert.equal(
              await windows.close({
                view: "main",
              }),
              false,
            );
            assert.equal(quitAttempts, 1);
            assert(
              (await windows.list()).find((spec) => spec.view === "main")?.open,
            );
            const reopening = assert.rejects(
              windows.create({
                view: "editor",
              }),
              (error: unknown) =>
                (
                  error as {
                    code: string;
                  }
                ).code === "CANCELLED",
            );
            await Bun.sleep(20); // revoke the caller while the editor still drains
            await assert.rejects(
              windows.close({
                view: "main",
              }),
              (error: unknown) =>
                (
                  error as {
                    code: string;
                  }
                ).code === "CANCELLED",
            );
            await reopening;
            assert.equal(quitAttempts, 2);
            assert.equal(auxiliaryDocuments, 4);
            await writeFile(
              reportPath,
              JSON.stringify({
                pass: true,
                auxiliaryDocuments,
                cancellations,
                cancelledCreation: true,
                browserFailureClosed: true,
              }),
            );
          }
          return null;
        },
      },
    },
  });
  await runWindowsApp(app, {
    runtime: {
      id: "windows-window-api",
      generation: crypto.randomUUID(),
    },
    backendContext: `backend-${crypto.randomUUID()}` as HostContext,
    policy,
    windows: [
      "main",
      "editor",
    ].map((view) => ({
      view,
      title: `Window API ${view}`,
      home: `https://app.bunaway.local/${view === "main" ? "index" : "editor"}.html`,
      window: {
        width: view === "editor" ? 300 : 800,
        height: view === "editor" ? 1000 : 600,
        ...(view === "editor"
          ? {
              minWidth: 500,
              minHeight: 400,
              maxWidth: 1200,
              maxHeight: 900,
            }
          : {}),
      },
      startup: view === "main",
    })),
    assets,
    dataRoot: resolve(output, `data-${process.pid}`),
    loader: resolve(
      root,
      "native/windows/bun/vendor/sdk/build/native/x64/WebView2Loader.dll",
    ),
  });
  process.exit(0);
}
