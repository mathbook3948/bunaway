import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CommandContext, defineApp } from "@bunaway/backend";
import { windows, windowsPlugin } from "@bunaway/plugin-windows";
import type { HostContext, Policy } from "@bunaway/protocol";
import { runWindowsApp } from "#native/windows/bun/entry";
import { Windows } from "#native/windows/bun/win32";
import { user } from "#native/windows/bun/win32-bindings";
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
    // Check fullscreen restoration across visibility and show states.
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
    assets,
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
  /** Checks native client dimensions against logical size at the current DPI. */
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
  /** Checks maximize bounds and restoration to the configured client size. */
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
    assert(width >= 700);
    assert(width <= 800);
    assert(height >= 500);
    assert(height <= 700);
    driver.symbols.ShowWindow(hwnd, 9);
    while (driver.symbols.IsZoomed(hwnd)) {
      assert(Date.now() < deadline, "Window did not restore.");
      await Bun.sleep(10);
    }
    assertClientSize(hwnd, 700, 550);
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
            // Kill only the editor renderer to check view-local recovery.
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
            assertClientSize(hwnd, 700, 550);
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
          if (event.event === "window-close-confirmation") {
            const answer = ++confirmations === 1 ? 7n : 6n; // IDNO then IDYES
            const deadline = Date.now() + 10000;
            // Poll because the native confirmation dialog appears asynchronously.
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
  /** Waits for state changes reported by separate WebView documents. */
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
  /** Query before the next setter; delayed stdout can observe a later resize. */
  async function assertContentSize(width: number, height: number) {
    const size = await windows.getContentSize({
      view: "editor",
      unit: "logical",
    });
    assert.equal(size.width, width);
    assert.equal(size.height, height);
  }
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
          for (const name of [
            "minimize",
            "maximize",
            "unmaximize",
            "restore",
            "toggleMaximize",
            "isMinimized",
            "isMaximized",
            "isFullscreen",
            "isVisible",
            "isFocused",
            "showInactive",
            "blur",
            "activate",
          ] as const) {
            await assert.rejects(
              windows[name]({
                view: "main",
              }),
              {
                code: "PERMISSION_DENIED",
              },
            );
          }
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
          // First run covers sizing/fullscreen; later runs cover recreation and renderer recovery.
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
                maxWidth: 800,
                maxHeight: 600,
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
                width: 800,
                height: 600,
              },
            );
            await assertContentSize(500, 600);
            await waitFor(() => holds === 1);
            const editor = {
              view: "editor",
            };
            await windows.hide(editor);
            assert.equal(await windows.activate(editor), false);
            await windows.showInactive(editor);
            assert.equal(await windows.isVisible(editor), true);
            assert.equal(await windows.isFocused(editor), false);
            await windows.minimize(editor);
            assert.equal(await windows.activate(editor), false);
            await windows.showInactive(editor);
            assert.equal(await windows.isMinimized(editor), true);
            await windows.unmaximize(editor);
            const activated = await windows.activate(editor);
            assert.equal(activated, await windows.isFocused(editor));
            const blurred = await windows.blur(editor);
            assert.equal(blurred, !(await windows.isFocused(editor)));
            assert.equal(await windows.isVisible(editor), true);
            assert.equal(await windows.isMinimized(editor), false);
            assert.equal(await windows.isMaximized(editor), false);
            await windows.maximize(editor);
            assert.equal(await windows.isMaximized(editor), true);
            await windows.minimize(editor);
            assert.equal(await windows.isMinimized(editor), true);
            await windows.restore(editor);
            assert.equal(await windows.isMaximized(editor), true);
            await windows.minimize(editor);
            await windows.unmaximize(editor);
            assert.equal(await windows.isMinimized(editor), false);
            assert.equal(await windows.isMaximized(editor), false);
            await windows.toggleMaximize(editor);
            assert.equal(await windows.isMaximized(editor), true);
            await windows.toggleMaximize(editor);
            assert.equal(await windows.isMaximized(editor), false);
            for (const name of [
              "minimize",
              "maximize",
              "unmaximize",
              "restore",
              "toggleMaximize",
            ] as const) {
              await windows.hide(editor);
              assert.equal(await windows.isVisible(editor), false);
              assert.equal(await windows.isFocused(editor), false);
              await windows[name](editor);
              assert.equal(await windows.isVisible(editor), true);
              await windows.unmaximize(editor);
            }
            console.log(
              JSON.stringify({
                event: "window-api-state",
              }),
            );
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
              width: 700,
              height: 550,
            });
            await windows.setPosition({
              view: "editor",
              x: 20,
              y: 30,
            });
            // Verify the public API through the real core, UI worker and HWND.
            const content = await windows.getContentSize({
              view: "editor",
              unit: "logical",
            });
            assert.equal(content.width, 700);
            assert.equal(content.height, 550);
            assert.deepEqual(
              {
                ...(await windows.getOuterPosition({
                  view: "editor",
                })),
              },
              {
                x: 20,
                y: 30,
                dpi: content.dpi,
              },
            );
            const outer = await windows.getOuterBounds({
              view: "editor",
            });
            assert.deepEqual(
              await windows.getNormalBounds({
                view: "editor",
              }),
              outer,
            );
            const inner = await windows.getContentBounds({
              view: "editor",
            });
            assert(inner.x >= outer.x && inner.y > outer.y);
            assert(outer.width > inner.width && outer.height > inner.height);
            assert.deepEqual(
              {
                ...(await windows.getOuterSize({
                  view: "editor",
                })),
              },
              {
                width: outer.width,
                height: outer.height,
                dpi: outer.dpi,
              },
            );
            assert.deepEqual(
              {
                ...(await windows.getContentPosition({
                  view: "editor",
                })),
              },
              {
                x: inner.x,
                y: inner.y,
                dpi: inner.dpi,
              },
            );
            const physical = await windows.toPhysical({
              view: "editor",
              value: {
                width: 700,
                height: 550,
              },
            });
            assert.deepEqual(
              {
                ...physical,
                value: {
                  ...physical.value,
                },
              },
              {
                value: {
                  width: inner.width,
                  height: inner.height,
                },
                dpi: content.dpi,
              },
            );
            const logical = await windows.toLogical({
              view: "editor",
              value: physical.value,
            });
            assert.deepEqual(
              {
                ...logical,
                value: {
                  ...logical.value,
                },
              },
              {
                value: {
                  width: 700,
                  height: 550,
                },
                dpi: content.dpi,
              },
            );
            await windows.setSize({
              view: "editor",
              width: 300,
              height: 300,
            });
            await assertContentSize(500, 400);
            await windows.setSize({
              view: "editor",
              width: 1000,
              height: 800,
            });
            await assertContentSize(800, 600);
            await windows.setSizeConstraints({
              view: "editor",
              minWidth: 600,
              maxWidth: 750,
              maxHeight: 550,
            });
            await assertContentSize(750, 550);
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
                maxWidth: 750,
                maxHeight: 550,
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
              width: 650,
              height: 550,
            });
            await windows.setSizeConstraints({
              view: "editor",
              minWidth: 600,
              minHeight: 500,
              maxWidth: 800,
              maxHeight: 700,
            });
            await windows.setFullscreen({
              view: "editor",
              fullscreen: true,
            });
            assert.equal(await windows.isFullscreen(editor), true);
            for (const name of [
              "minimize",
              "maximize",
              "unmaximize",
              "restore",
              "toggleMaximize",
            ] as const) {
              await assert.rejects(windows[name](editor), {
                code: "INVALID_ARGUMENT",
              });
            }
            await assert.rejects(
              windows.setSize({
                view: "editor",
                width: 500,
                height: 400,
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
              minWidth: 700,
              minHeight: 500,
              maxWidth: 800,
              maxHeight: 700,
            });
            assert.deepEqual(
              {
                ...(await windows.getSizeConstraints({
                  view: "editor",
                })),
              },
              {
                minWidth: 700,
                minHeight: 500,
                maxWidth: 800,
                maxHeight: 700,
              },
            );
            await windows.setFullscreen({
              view: "editor",
              fullscreen: false,
            });
            await assertContentSize(700, 550);
            assert.equal(await windows.isFullscreen(editor), false);
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
                maxWidth: 800,
                maxHeight: 600,
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
            // Renderer failure revokes this document while the main view is recreated.
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
            // Race a pending editor creation against caller revocation during main-window close.
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
              maxWidth: 800,
              maxHeight: 600,
            }
          : {}),
      },
      startup: view === "main",
    })),
    assets,
    dataRoot: resolve(output, `data-${process.pid}`),
    loader: resolve(
      root,
      "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
    ),
  });
  process.exit(0);
}
