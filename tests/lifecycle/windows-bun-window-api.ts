import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CommandContext, defineApp } from "@bunaway/backend";
import windows from "@bunaway/plugin-windows";
import { BunawayError, type HostContext, type Policy } from "@bunaway/protocol";
import { runWindowsApp } from "#native/windows/bun/entry";
import { monitorServices } from "#native/windows/bun/monitors";
import { Windows } from "#native/windows/bun/win32";
import { hr, ole, user } from "#native/windows/bun/win32-bindings";
import { testAppMetadata } from "../fixtures/app-info.ts";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";
import { windowPermissions } from "../fixtures/window-permissions.ts";

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
        "test.run",
      ],
      events: [],
      host: {
        permissions: [
          ...windowPermissions(),
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
    SendMessageW: {
      args: [
        "u64",
        "u32",
        "u64",
        "i64",
      ],
      returns: "i64",
    },
    GetMenuState: {
      args: [
        "u64",
        "u32",
        "u32",
      ],
      returns: "u32",
    },
  });
  // No ui.ts here, so this block owns the STA that AccPropServices and the windows need.
  hr(ole.symbols.CoInitializeEx(null, 2), "CoInitializeEx(STA)");
  const nativeWindows = new Windows(() => {});
  try {
    const source = nativeWindows.create(
      "Focusability source",
      650,
      450,
      () => {},
    );
    try {
      nativeWindows.focus(source);
      for (const visible of [
        false,
        true,
      ]) {
        const foreground = user.symbols.GetForegroundWindow();
        let inactiveCloseRequests = 0;
        const hwnd = nativeWindows.create(
          "Nonactivating target",
          650,
          450,
          (message) => {
            if (message === 0x0010) {
              inactiveCloseRequests++;
            }
          },
          visible,
          {
            focusable: false,
          },
        );
        try {
          assert.equal(nativeWindows.isFocusable(hwnd), false);
          assert.equal(nativeWindows.isVisible(hwnd), visible);
          assert.equal(user.symbols.GetForegroundWindow(), foreground);
          assert.equal(
            driver.symbols.SendMessageW(hwnd, 0x0021, hwnd, 0x02010001n),
            3n,
          );
          assert.equal(nativeWindows.focus(hwnd), false);
          assert.equal(nativeWindows.activate(hwnd), false);
          assert.equal(nativeWindows.isVisible(hwnd), visible);
          const original = nativeWindows.getBounds(hwnd, "outer");
          nativeWindows.setFocusable(hwnd, true);
          nativeWindows.setFocusable(hwnd, false);
          assert.deepEqual(nativeWindows.getBounds(hwnd, "outer"), original);
          assert.equal(user.symbols.GetForegroundWindow(), foreground);
          nativeWindows.show(hwnd, true);
          assert.equal(user.symbols.GetForegroundWindow(), foreground);
          nativeWindows.maximize(hwnd);
          assert.equal(nativeWindows.isMaximized(hwnd), true);
          assert.equal(user.symbols.GetForegroundWindow(), foreground);
          nativeWindows.unmaximize(hwnd);
          assert.deepEqual(nativeWindows.getBounds(hwnd, "outer"), original);
          assert.equal(user.symbols.GetForegroundWindow(), foreground);
          for (const command of [
            0xf020n,
            0xf120n,
            0xf030n,
            0xf120n,
          ]) {
            driver.symbols.SendMessageW(hwnd, 0x0112, command, 0n);
            assert.equal(nativeWindows.isMinimized(hwnd), command === 0xf020n);
            assert.equal(nativeWindows.isMaximized(hwnd), command === 0xf030n);
            assert.equal(user.symbols.GetForegroundWindow(), foreground);
          }
          assert.deepEqual(nativeWindows.getBounds(hwnd, "outer"), original);
          nativeWindows.maximize(hwnd);
          nativeWindows.minimize(hwnd);
          nativeWindows.restore(hwnd);
          assert.equal(nativeWindows.isMaximized(hwnd), true);
          assert.equal(user.symbols.GetForegroundWindow(), foreground);
          nativeWindows.unmaximize(hwnd);
          assert.deepEqual(nativeWindows.getBounds(hwnd, "outer"), original);
          nativeWindows.setFullscreen(hwnd, true);
          nativeWindows.setFocusable(hwnd, true);
          nativeWindows.setFocusable(hwnd, false);
          nativeWindows.setFullscreen(hwnd, false);
          assert.equal(nativeWindows.isFocusable(hwnd), false);
          assert.equal(user.symbols.GetForegroundWindow(), foreground);
          nativeWindows.show(hwnd, false);
          nativeWindows.showForDesktop(hwnd);
          assert.equal(nativeWindows.isVisible(hwnd), true);
          assert.equal(nativeWindows.isMinimized(hwnd), false);
          assert.equal(user.symbols.GetForegroundWindow(), foreground);
          nativeWindows.minimize(hwnd);
          nativeWindows.showForDesktop(hwnd);
          assert.equal(nativeWindows.isMinimized(hwnd), false);
          assert.deepEqual(nativeWindows.getBounds(hwnd, "outer"), original);
          assert.equal(user.symbols.GetForegroundWindow(), foreground);
          nativeWindows.maximize(hwnd);
          nativeWindows.minimize(hwnd);
          nativeWindows.showForDesktop(hwnd);
          assert.equal(nativeWindows.isMaximized(hwnd), true);
          assert.equal(user.symbols.GetForegroundWindow(), foreground);
          nativeWindows.unmaximize(hwnd);
          assert.deepEqual(nativeWindows.getBounds(hwnd, "outer"), original);
          nativeWindows.setMinimizable(hwnd, false);
          nativeWindows.setMaximizable(hwnd, false);
          nativeWindows.setClosable(hwnd, false);
          for (const command of [
            0xf020n,
            0xf030n,
            0xf060n,
          ]) {
            driver.symbols.SendMessageW(hwnd, 0x0112, command, 0n);
          }
          driver.symbols.SendMessageW(hwnd, 0x0010, 0n, 0n);
          assert.equal(inactiveCloseRequests, 0);
          assert.equal(nativeWindows.isMinimized(hwnd), false);
          assert.equal(nativeWindows.isMaximized(hwnd), false);
          // Caption restrictions do not block trusted state APIs or desktop restoration.
          nativeWindows.maximize(hwnd);
          nativeWindows.minimize(hwnd);
          nativeWindows.showForDesktop(hwnd);
          assert.equal(nativeWindows.isMaximized(hwnd), true);
          assert.equal(nativeWindows.isMinimized(hwnd), false);
          assert.equal(user.symbols.GetForegroundWindow(), foreground);
          nativeWindows.unmaximize(hwnd);
          assert.deepEqual(nativeWindows.getBounds(hwnd, "outer"), original);
          nativeWindows.setClosable(hwnd, true);
          driver.symbols.SendMessageW(hwnd, 0x0010, 0n, 0n);
          assert.equal(inactiveCloseRequests, 1);
        } finally {
          nativeWindows.destroy(hwnd);
        }
      }
    } finally {
      nativeWindows.destroy(source);
    }
    for (const visible of [
      false,
      true,
    ]) {
      let closeRequests = 0;
      const hwnd = nativeWindows.create(
        "Caption control regression",
        650,
        450,
        (message) => {
          if (message === 0x0010) {
            closeRequests++;
          }
        },
        visible,
      );
      try {
        const original = nativeWindows.getBounds(hwnd, "outer");
        const foreground = user.symbols.GetForegroundWindow();
        nativeWindows.setMinimizable(hwnd, false);
        nativeWindows.setMaximizable(hwnd, false);
        nativeWindows.setClosable(hwnd, false);
        assert.equal(nativeWindows.isMinimizable(hwnd), false);
        assert.equal(nativeWindows.isMaximizable(hwnd), false);
        assert.equal(nativeWindows.isClosable(hwnd), false);
        assert(
          driver.symbols.GetMenuState(
            user.symbols.GetSystemMenu(hwnd, 0),
            0xf060,
            0,
          ) & 1,
        );
        for (const command of [
          0xf020n,
          0xf030n,
          0xf060n,
        ]) {
          driver.symbols.SendMessageW(hwnd, 0x0112, command, 0n);
        }
        driver.symbols.SendMessageW(hwnd, 0x0010, 0n, 0n);
        assert.equal(closeRequests, 0);
        assert.equal(nativeWindows.isMinimized(hwnd), false);
        assert.equal(nativeWindows.isMaximized(hwnd), false);
        assert.equal(nativeWindows.isVisible(hwnd), visible);
        assert.equal(user.symbols.GetForegroundWindow(), foreground);
        assert.deepEqual(nativeWindows.getBounds(hwnd, "outer"), original);
        nativeWindows.setFullscreen(hwnd, true);
        nativeWindows.setClosable(hwnd, true);
        nativeWindows.setClosable(hwnd, false);
        nativeWindows.setMinimizable(hwnd, true);
        nativeWindows.setMaximizable(hwnd, true);
        nativeWindows.setFullscreen(hwnd, false);
        assert.equal(nativeWindows.isMinimizable(hwnd), true);
        assert.equal(nativeWindows.isMaximizable(hwnd), true);
        assert.equal(nativeWindows.isClosable(hwnd), false);
        nativeWindows.setClosable(hwnd, true);
        assert.equal(
          driver.symbols.GetMenuState(
            user.symbols.GetSystemMenu(hwnd, 0),
            0xf060,
            0,
          ) & 3,
          0,
        );
        driver.symbols.SendMessageW(hwnd, 0x0010, 0n, 0n);
        assert.equal(closeRequests, 1);
        assert.equal(nativeWindows.isVisible(hwnd), visible);
        assert.deepEqual(nativeWindows.getBounds(hwnd, "outer"), original);
      } finally {
        nativeWindows.destroy(hwnd);
      }
      assert.throws(() => nativeWindows.isClosable(hwnd));
    }
    for (const maximized of [
      false,
      true,
    ]) {
      for (const fullscreen of [
        false,
        true,
      ]) {
        for (const visible of [
          false,
          true,
        ]) {
          const hwnd = nativeWindows.create(
            "Initial state regression",
            650,
            450,
            () => {},
            visible,
            {
              maximized,
              fullscreen,
              x: 80,
              y: 100,
            },
          );
          try {
            assert.equal(nativeWindows.isMaximized(hwnd), maximized);
            assert.equal(nativeWindows.isFullscreen(hwnd), fullscreen);
            assert.equal(nativeWindows.isVisible(hwnd), visible);
            const normal = nativeWindows.getBounds(hwnd, "normal");
            assert.equal(normal.x, 80);
            assert.equal(normal.y, 100);
            if (fullscreen) {
              nativeWindows.setFullscreen(hwnd, false);
              assert.equal(nativeWindows.isVisible(hwnd), visible);
              assert.equal(nativeWindows.isMaximized(hwnd), maximized);
              assert.deepEqual(nativeWindows.getBounds(hwnd, "normal"), normal);
            }
            if (maximized) {
              nativeWindows.unmaximize(hwnd);
            }
            const content = nativeWindows.getBounds(hwnd, "content");
            assert.equal(content.width, Math.round((650 * content.dpi) / 96));
            assert.equal(content.height, Math.round((450 * content.dpi) / 96));
          } finally {
            nativeWindows.destroy(hwnd);
          }
        }
      }
    }
    const pixelWindow = nativeWindows.create(
      "Physical client preservation",
      650,
      450,
      () => {},
      false,
    );
    try {
      nativeWindows.setGeometry(pixelWindow, "content", {
        width: 601,
        height: 451,
      });
      const foreground = user.symbols.GetForegroundWindow();
      for (const resizable of [
        false,
        true,
        false,
        true,
      ]) {
        nativeWindows.setResizable(pixelWindow, resizable);
        const content = nativeWindows.getBounds(pixelWindow, "content");
        assert.equal(content.width, 601);
        assert.equal(content.height, 451);
        assert.equal(nativeWindows.isVisible(pixelWindow), false);
        assert.equal(user.symbols.GetForegroundWindow(), foreground);
      }
    } finally {
      nativeWindows.destroy(pixelWindow);
    }
    // Exercise real frame changes and blocked native user commands, including low command bits.
    for (const showCmd of [
      1,
      2,
      3,
    ]) {
      for (const visible of [
        true,
        false,
      ]) {
        let modalEnters = 0;
        const hwnd = nativeWindows.create(
          "User movement regression",
          650,
          450,
          (message) => {
            if (message === 0x0231) {
              modalEnters++;
            }
          },
        );
        try {
          user.symbols.ShowWindow(hwnd, showCmd);
          if (!visible) {
            nativeWindows.show(hwnd, false);
          }
          const foreground = user.symbols.GetForegroundWindow();
          nativeWindows.setMovable(hwnd, false);
          nativeWindows.setResizable(hwnd, false);
          assert.equal(nativeWindows.isResizable(hwnd), false);
          assert.equal(nativeWindows.isMovable(hwnd), false);
          assert.equal(driver.symbols.IsWindowVisible(hwnd), Number(visible));
          assert.equal(driver.symbols.IsIconic(hwnd), Number(showCmd === 2));
          assert.equal(driver.symbols.IsZoomed(hwnd), Number(showCmd === 3));
          assert.equal(user.symbols.GetForegroundWindow(), foreground);
          const frame = nativeWindows.getBounds(hwnd, "outer");
          for (const command of [
            0xf001n,
            0xf012n,
          ]) {
            driver.symbols.SendMessageW(hwnd, 0x0112, command, 0n);
            assert.equal(modalEnters, 0);
            assert.deepEqual(nativeWindows.getBounds(hwnd, "outer"), frame);
          }
          // Fullscreen changes the rendered frame but retains the normal resize policy.
          nativeWindows.setFullscreen(hwnd, true);
          nativeWindows.setResizable(hwnd, true);
          assert.equal(nativeWindows.isResizable(hwnd), true);
          nativeWindows.setResizable(hwnd, false);
          nativeWindows.setFullscreen(hwnd, false);
          assert.equal(nativeWindows.isResizable(hwnd), false);
          assert.equal(nativeWindows.isMovable(hwnd), false);
          nativeWindows.setResizable(hwnd, true);
          nativeWindows.setMovable(hwnd, true);
          assert.equal(nativeWindows.isResizable(hwnd), true);
          assert.equal(nativeWindows.isMovable(hwnd), true);
          assert.equal(user.symbols.GetForegroundWindow(), foreground);
          assert.equal(driver.symbols.IsWindowVisible(hwnd), Number(visible));
          assert.equal(driver.symbols.IsIconic(hwnd), Number(showCmd === 2));
          assert.equal(driver.symbols.IsZoomed(hwnd), Number(showCmd === 3));
          nativeWindows.unmaximize(hwnd);
          const content = nativeWindows.getBounds(hwnd, "content");
          assert.equal(content.width, Math.round((650 * content.dpi) / 96));
          assert.equal(content.height, Math.round((450 * content.dpi) / 96));
        } finally {
          nativeWindows.destroy(hwnd);
        }
        assert.throws(() => nativeWindows.isMovable(hwnd));
      }
    }
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
          const titleForeground = user.symbols.GetForegroundWindow();
          for (const title of [
            "창 제목 📝",
            "📝".repeat(512),
          ]) {
            nativeWindows.setTitle(hwnd, title);
            assert.equal(nativeWindows.getTitle(hwnd), title);
            assert.equal(driver.symbols.IsWindowVisible(hwnd), Number(visible));
            assert.equal(driver.symbols.IsIconic(hwnd), minimized);
            assert.equal(driver.symbols.IsZoomed(hwnd), maximized);
            assert.equal(user.symbols.GetForegroundWindow(), titleForeground);
            assert(driver.symbols.GetWindowRect(hwnd, ptr(restored)));
            assert.deepEqual(
              [
                ...restored,
              ],
              [
                ...frame,
              ],
            );
          }
          // Query the actual HWND caption, including trusted native changes outside the plugin.
          const externalTitle = Buffer.from("Native caption\0", "utf16le");
          assert(user.symbols.SetWindowTextW(hwnd, ptr(externalTitle)));
          assert.equal(nativeWindows.getTitle(hwnd), "Native caption");
          // Accessible titles live beside the caption and never rewrite it.
          assert.equal(nativeWindows.getAccessibleTitle(hwnd), null);
          nativeWindows.setAccessibleTitle(hwnd, "읽기용 제목 📝");
          assert.equal(
            nativeWindows.getAccessibleTitle(hwnd),
            "읽기용 제목 📝",
          );
          assert.equal(nativeWindows.getTitle(hwnd), "Native caption");
          nativeWindows.setAccessibleTitle(hwnd, "");
          assert.equal(nativeWindows.getAccessibleTitle(hwnd), null);
          nativeWindows.setAccessibleTitle(hwnd, "Destroyed with annotation");
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
          // Runtime centering keeps HWND state and centers normal restoration bounds.
          const monitor = user.symbols.MonitorFromWindow(hwnd, 2);
          const info = Buffer.alloc(40);
          info.writeUInt32LE(40);
          assert(user.symbols.GetMonitorInfoW(monitor, ptr(info)));
          const normal = nativeWindows.getBounds(hwnd, "normal");
          const expected = {
            ...normal,
            x: Math.round(
              info.readInt32LE(20) +
                (info.readInt32LE(28) - info.readInt32LE(20) - normal.width) /
                  2,
            ),
            y: Math.round(
              info.readInt32LE(24) +
                (info.readInt32LE(32) - info.readInt32LE(24) - normal.height) /
                  2,
            ),
          };
          const foreground = user.symbols.GetForegroundWindow();
          nativeWindows.center(hwnd);
          assert.deepEqual(nativeWindows.getBounds(hwnd, "normal"), expected);
          assert.equal(driver.symbols.IsWindowVisible(hwnd), Number(visible));
          assert.equal(driver.symbols.IsIconic(hwnd), minimized);
          assert.equal(driver.symbols.IsZoomed(hwnd), maximized);
          assert.equal(user.symbols.GetForegroundWindow(), foreground);
          nativeWindows.center(hwnd);
          assert.deepEqual(nativeWindows.getBounds(hwnd, "normal"), expected);
          // A public monitor ID selects that monitor's work area; the CI host has one monitor.
          const monitorId = monitorServices
            .list()
            .find(
              (candidate) =>
                candidate.workArea.x === info.readInt32LE(20) &&
                candidate.workArea.y === info.readInt32LE(24),
            )?.id;
          assert(monitorId);
          const moveOffCenter = () => {
            nativeWindows.setGeometry(hwnd, "outer", {
              x: expected.x - 37,
              y: expected.y - 23,
            });
            const moved = nativeWindows.getBounds(hwnd, "normal");
            assert.notDeepEqual(moved, expected);
            return moved;
          };
          // Start off-center so a fallback to the current monitor cannot pass unnoticed.
          moveOffCenter();
          nativeWindows.center(hwnd, monitorId);
          assert.deepEqual(nativeWindows.getBounds(hwnd, "normal"), expected);
          assert.equal(driver.symbols.IsWindowVisible(hwnd), Number(visible));
          assert.equal(driver.symbols.IsIconic(hwnd), minimized);
          assert.equal(driver.symbols.IsZoomed(hwnd), maximized);
          // An unknown ID fails before any geometry change and never falls back.
          const movedBeforeReject = moveOffCenter();
          assert.throws(
            () => nativeWindows.center(hwnd, "\\\\.\\DISPLAY999"),
            (error: unknown) =>
              error instanceof BunawayError &&
              error.code === "INVALID_ARGUMENT",
          );
          assert.deepEqual(
            nativeWindows.getBounds(hwnd, "normal"),
            movedBeforeReject,
          );
        } finally {
          nativeWindows.destroy(hwnd);
        }
      }
    }
  } finally {
    try {
      nativeWindows.dispose();
    } finally {
      ole.symbols.CoUninitialize();
    }
  }
  // Keep transient hidden-state checks in host:windows even when the general test suite
  // runs before WebView2 inputs are prepared and skips its platform-specific coverage.
  for (const state of [
    [],
    [
      "--maximized",
    ],
    [
      "--fullscreen",
    ],
    [
      "--maximized",
      "--fullscreen",
    ],
  ]) {
    const hidden = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        resolve(root, "tests/lifecycle/windows-hidden-webview.fixture.ts"),
        ...state,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 65_000,
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      hidden.exited,
      new Response(hidden.stdout).text(),
      new Response(hidden.stderr).text(),
    ]);
    assert.equal(code, 0, `${state.join(" ")}: ${stderr}\n${stdout}`);
    assert(stdout.includes("zero show/activation/focus messages or WinEvents"));
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
  const dialogTitle = Buffer.from("수정된 제목 📝\0", "utf16le");
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
          if (
            typeof event.event === "string" &&
            (event.event.startsWith("window-api-") ||
              event.event === "window-close-confirmation")
          ) {
            console.log(`Window API stage: ${event.event}`);
          }
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
      "PASS Windows public window API: identity lookup, navigation identity preservation, native recreation identity replacement, destroyed and normal state, size constraints, GetDpiForWindow scaling at the current monitor, maximize and restore, fullscreen visibility, geometry, close refusal, browser failure, dynamic creation, fresh sessions and revoked creation",
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
  let mainWindowId = "";
  let editorWindowId = "";
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
      windows,
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
            "isNormal",
            "isDestroyed",
            "showInactive",
            "blur",
            "activate",
            "getMonitor",
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
          for (const lookup of [
            windows.getCurrent,
            windows.getFocused,
            windows.getLastActive,
            windows.getMonitors,
            windows.getPrimaryMonitor,
            windows.getCursorPosition,
          ]) {
            await assert.rejects(lookup(), {
              code: "PERMISSION_DENIED",
            });
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
          const current = await windows.getCurrent();
          assert(current && current.viewId === "main");
          const snapshot = await windows.getSnapshot({
            view: "main",
          });
          const monitors = await windows.getMonitors();
          assert(monitors.length > 0);
          const primary = await windows.getPrimaryMonitor();
          assert(
            primary.primary &&
              monitors.some((monitor) => monitor.id === primary.id),
          );
          const monitor = await windows.getMonitor({
            view: "main",
            windowId: current.windowId,
          });
          assert(monitors.some((entry) => entry.id === monitor.id));
          const point = {
            x: monitor.bounds.x,
            y: monitor.bounds.y,
          };
          assert.equal(
            (await windows.getMonitorNearestPoint(point)).id,
            monitor.id,
          );
          assert.equal(
            (await windows.getMonitorNearestRect(monitor.bounds)).id,
            monitor.id,
          );
          const cursor = await windows.getCursorPosition();
          assert(Number.isInteger(cursor.x) && Number.isInteger(cursor.y));
          assert.equal(current.windowId, snapshot.windowId);
          assert.deepEqual(
            await windows.getById({
              windowId: current.windowId,
            }),
            current,
          );
          assert.equal(
            await windows.getById({
              windowId: "main",
            }),
            null,
          );
          if (runs === 1 || runs === 2) {
            assert.equal(
              current.windowId,
              mainWindowId,
              "navigation preserves native identity",
            );
          } else if (runs === 3) {
            assert.notEqual(
              current.windowId,
              mainWindowId,
              "native recreation replaces identity",
            );
            assert.equal(
              await windows.getById({
                windowId: mainWindowId,
              }),
              null,
            );
          }
          mainWindowId = current.windowId;
          // Exercise the public plugin, actual UI STA and ITaskbarList3 on each native lifetime.
          // Explorer creates buttons asynchronously; WebView readiness does not imply button readiness.
          await waitFor(async () => {
            try {
              await windows.setTaskbarProgress({
                view: "main",
                windowId: current.windowId,
                state: "indeterminate",
              });
              return true;
            } catch (error) {
              if (
                error instanceof Error &&
                "code" in error &&
                error.code === "BUSY"
              ) {
                return false;
              }
              throw error;
            }
          });
          for (const state of [
            "normal",
            "paused",
            "error",
          ] as const) {
            assert.equal(
              await windows.setTaskbarProgress({
                view: "main",
                windowId: current.windowId,
                state,
                value: 0.375,
              }),
              null,
            );
          }
          assert.equal(
            await windows.setTaskbarProgress({
              view: "main",
              windowId: current.windowId,
              state: "none",
            }),
            null,
          );
          // The button exists now, so thumbnail calls reach the real ITaskbarList3.
          const thumbnailTarget = {
            view: "main",
            windowId: current.windowId,
          };
          assert.equal(
            await windows.setThumbnailClip({
              ...thumbnailTarget,
              region: {
                x: 0,
                y: 0,
                width: 100,
                height: 80,
              },
            }),
            null,
          );
          // A minimized HWND has an empty client rectangle and an unknown restored size, so only the
          // lower bounds are checked while minimized; the upper bound is left to the shell.
          await windows.minimize(thumbnailTarget);
          assert.equal(await windows.isMinimized(thumbnailTarget), true);
          assert.equal(
            await windows.setThumbnailClip({
              ...thumbnailTarget,
              region: {
                x: 0,
                y: 0,
                width: 100,
                height: 80,
              },
            }),
            null,
          );
          // Lower-bound violations stay rejected while minimized.
          await assert.rejects(
            windows.setThumbnailClip({
              ...thumbnailTarget,
              region: {
                x: -1,
                y: 0,
                width: 100,
                height: 80,
              },
            }),
            {
              code: "INVALID_ARGUMENT",
            },
          );
          await windows.restore(thumbnailTarget);
          assert.equal(await windows.isMinimized(thumbnailTarget), false);
          // Minimizing from maximized restores to a larger area, so no upper bound is checked then.
          await windows.maximize(thumbnailTarget);
          await windows.minimize(thumbnailTarget);
          assert.equal(
            await windows.setThumbnailClip({
              ...thumbnailTarget,
              region: {
                x: 0,
                y: 0,
                width: 100,
                height: 80,
              },
            }),
            null,
          );
          await windows.restore(thumbnailTarget);
          assert.equal(await windows.isMaximized(thumbnailTarget), true);
          await windows.unmaximize(thumbnailTarget);
          assert.equal(await windows.isMaximized(thumbnailTarget), false);
          await assert.rejects(
            windows.setThumbnailClip({
              ...thumbnailTarget,
              region: {
                x: 0,
                y: 0,
                width: 100_000,
                height: 80,
              },
            }),
            {
              code: "INVALID_ARGUMENT",
            },
          );
          assert.equal(
            await windows.setThumbnailClip({
              ...thumbnailTarget,
              region: null,
            }),
            null,
          );
          for (const toolTip of [
            "Window preview",
            "",
            null,
          ]) {
            assert.equal(
              await windows.setThumbnailToolTip({
                ...thumbnailTarget,
                toolTip,
              }),
              null,
            );
          }
          // First run covers sizing/fullscreen; later runs cover recreation and renderer recovery.
          if (++runs === 1) {
            assert.equal(
              await windows.isDestroyed({
                view: "editor",
              }),
              true,
            );
            await windows.create({
              view: "editor",
              options: {
                window: {
                  focusable: false,
                  maximized: true,
                  fullscreen: true,
                },
                visible: false,
              },
            });
            const initiallyFullscreen = {
              view: "editor",
            };
            assert.equal(await windows.isFullscreen(initiallyFullscreen), true);
            assert.equal(await windows.isMaximized(initiallyFullscreen), true);
            assert.equal(await windows.isVisible(initiallyFullscreen), false);
            await windows.setFullscreen({
              ...initiallyFullscreen,
              fullscreen: false,
            });
            assert.equal(await windows.isMaximized(initiallyFullscreen), true);
            assert.equal(await windows.isVisible(initiallyFullscreen), false);
            await windows.unmaximize(initiallyFullscreen);
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
            console.log(
              JSON.stringify({
                event: "window-api-focusability",
              }),
            );
            const editor = {
              view: "editor",
            };
            assert.equal(await windows.isFocusable(editor), false);
            await windows.setFocusable({
              ...editor,
              focusable: true,
            });
            assert.equal(await windows.isFocusable(editor), true);
            await windows.setFocusable({
              ...editor,
              focusable: false,
            });
            assert.equal(await windows.isFocusable(editor), false);
            await windows.setMinimizable({
              ...editor,
              minimizable: false,
            });
            await windows.setMaximizable({
              ...editor,
              maximizable: false,
            });
            await windows.setClosable({
              ...editor,
              closable: false,
            });
            assert.equal(await windows.isMinimizable(editor), false);
            assert.equal(await windows.isMaximizable(editor), false);
            assert.equal(await windows.isClosable(editor), false);
            assert.equal(await windows.getTitle(editor), "Window API editor");
            await windows.setTitle({
              ...editor,
              title: "수정된 제목 📝",
            });
            assert.equal(await windows.getTitle(editor), "수정된 제목 📝");
            await assert.rejects(
              windows.setTitle({
                ...editor,
                title: "invalid\0title",
              }),
              {
                code: "INVALID_ARGUMENT",
              },
            );
            assert.equal(await windows.getTitle(editor), "수정된 제목 📝");
            // The driver verifies that close confirmation uses this runtime caption.
            const editorSnapshot = await windows.getSnapshot(editor);
            editorWindowId = editorSnapshot.windowId;
            assert.equal(await windows.isDestroyed(editor), false);
            assert.equal(await windows.isNormal(editor), true);
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
            console.log(
              JSON.stringify({
                event: "window-api-maximize-history",
              }),
            );
            await windows.maximize(editor);
            assert.equal(await windows.isNormal(editor), false);
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
            const foreground = user.symbols.GetForegroundWindow();
            const lastActive = await windows.getLastActive();
            assert.deepEqual(
              {
                ...(await windows.getById({
                  windowId: editorWindowId,
                })),
              },
              {
                windowId: editorWindowId,
                viewId: "editor",
              },
            );
            await windows.getFocused();
            assert.equal(await windows.isVisible(editor), false);
            assert.equal(
              user.symbols.GetForegroundWindow(),
              foreground,
              "lookup must not activate a hidden window",
            );
            assert.deepEqual(await windows.getLastActive(), lastActive);
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
            assert.equal(await windows.isResizable(editor), true);
            assert.equal(await windows.isMovable(editor), true);
            await windows.setResizable({
              ...editor,
              resizable: false,
            });
            await windows.setMovable({
              ...editor,
              movable: false,
            });
            assert.equal(await windows.isResizable(editor), false);
            assert.equal(await windows.isMovable(editor), false);
            // Programmatic geometry remains available while user interactions are disabled.
            await windows.setSize({
              ...editor,
              width: 700,
              height: 550,
            });
            await windows.setPosition({
              view: "editor",
              x: 20,
              y: 30,
            });
            await windows.setResizable({
              ...editor,
              resizable: true,
            });
            await windows.setMovable({
              ...editor,
              movable: true,
            });
            assert.equal(await windows.getAspectRatio(editor), null);
            const beforeAspectRatio = await windows.getOuterBounds(editor);
            await windows.setAspectRatio({
              ...editor,
              ratio: 16 / 9,
            });
            assert.equal(await windows.getAspectRatio(editor), 16 / 9);
            // Setting the lock leaves the current size unchanged.
            assert.deepEqual(
              await windows.getOuterBounds(editor),
              beforeAspectRatio,
            );
            await assert.rejects(
              windows.setAspectRatio({
                ...editor,
                ratio: 0,
              }),
              {
                code: "INVALID_ARGUMENT",
              },
            );
            assert.equal(await windows.getAspectRatio(editor), 16 / 9);
            await windows.setAspectRatio({
              ...editor,
              ratio: null,
            });
            assert.equal(await windows.getAspectRatio(editor), null);
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
            await windows.hide(editor);
            const centerForeground = user.symbols.GetForegroundWindow();
            await windows.center(editor);
            const centered = await windows.getOuterBounds(editor);
            assert.equal(centered.width, outer.width);
            assert.equal(centered.height, outer.height);
            assert.equal(await windows.isVisible(editor), false);
            assert.equal(user.symbols.GetForegroundWindow(), centerForeground);
            await windows.center(editor);
            assert.deepEqual(await windows.getOuterBounds(editor), centered);
            // The centered window lies inside exactly one monitor work area.
            const centerTarget = (await windows.getMonitors()).find(
              (monitor) =>
                centered.x >= monitor.workArea.x &&
                centered.y >= monitor.workArea.y &&
                centered.x + centered.width <=
                  monitor.workArea.x + monitor.workArea.width &&
                centered.y + centered.height <=
                  monitor.workArea.y + monitor.workArea.height,
            );
            assert(centerTarget);
            await windows.setPosition({
              ...editor,
              x: outer.x,
              y: outer.y,
            });
            await windows.center({
              ...editor,
              monitorId: centerTarget.id,
            });
            assert.deepEqual(await windows.getOuterBounds(editor), centered);
            assert.deepEqual(
              {
                x: centered.x,
                y: centered.y,
              },
              {
                x: Math.round(
                  centerTarget.workArea.x +
                    (centerTarget.workArea.width - centered.width) / 2,
                ),
                y: Math.round(
                  centerTarget.workArea.y +
                    (centerTarget.workArea.height - centered.height) / 2,
                ),
              },
            );
            assert.equal(await windows.isVisible(editor), false);
            assert.equal(user.symbols.GetForegroundWindow(), centerForeground);
            // Start off-center so a fallback to the current monitor cannot pass unnoticed.
            await windows.setPosition({
              ...editor,
              x: outer.x,
              y: outer.y,
            });
            const movedBeforeReject = await windows.getOuterBounds(editor);
            assert.notDeepEqual(
              {
                x: movedBeforeReject.x,
                y: movedBeforeReject.y,
              },
              {
                x: centered.x,
                y: centered.y,
              },
            );
            await assert.rejects(
              windows.center({
                ...editor,
                monitorId: "\\\\.\\DISPLAY999",
              }),
              {
                code: "INVALID_ARGUMENT",
              },
            );
            assert.deepEqual(
              await windows.getOuterBounds(editor),
              movedBeforeReject,
            );
            await windows.setOuterBounds({
              ...editor,
              x: outer.x,
              y: outer.y,
              width: outer.width,
              height: outer.height,
            });
            await windows.show(editor);
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
              "center",
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
            await windows.setFocusable({
              ...editor,
              focusable: true,
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
            assert.equal(
              await windows.getById({
                windowId: editorWindowId,
              }),
              null,
            );
            assert.notEqual(
              (await windows.getSnapshot(editor)).windowId,
              editorWindowId,
            );
            await waitFor(() => holds === 2 && cancellations === 1);
          } else if (runs === 2) {
            assert.equal(
              await windows.isFocusable({
                view: "editor",
              }),
              true,
            );
            assert.equal(
              await windows.isMinimizable({
                view: "editor",
              }),
              true,
            );
            assert.equal(
              await windows.isMaximizable({
                view: "editor",
              }),
              true,
            );
            assert.equal(
              await windows.isClosable({
                view: "editor",
              }),
              true,
            );
            assert.equal(
              await windows.getTitle({
                view: "editor",
              }),
              "Window API editor",
            );
            editorWindowId = (
              await windows.getSnapshot({
                view: "editor",
              })
            ).windowId;
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
            assert.equal(
              await windows.isDestroyed({
                view: "editor",
              }),
              true,
            );
            assert.equal(
              await windows.getById({
                windowId: editorWindowId,
              }),
              null,
            );
            await assert.rejects(
              windows.isNormal({
                view: "editor",
              }),
              {
                code: "INVALID_ARGUMENT",
              },
            );
            await assert.rejects(
              windows.getAspectRatio({
                view: "editor",
              }),
              {
                code: "INVALID_ARGUMENT",
              },
            );
            await assert.rejects(
              windows.setAspectRatio({
                view: "editor",
                ratio: 1,
              }),
              {
                code: "INVALID_ARGUMENT",
              },
            );
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
                identityLookup: true,
                navigationPreservesIdentity: true,
              }),
            );
          }
          return null;
        },
      },
    },
  });
  await runWindowsApp(app, {
    appMetadata: testAppMetadata,
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
