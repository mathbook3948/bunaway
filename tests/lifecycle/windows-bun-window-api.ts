import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CommandContext, defineApp } from "@bunaway/backend";
import { checkHresult, pick, USER32 } from "@bunaway/plugin/win32";
import windows from "@bunaway/plugin-windows";
import { BunawayError, type HostContext, type Policy } from "@bunaway/protocol";
import { runWindowsApp } from "#native/windows/bun/entry";
import { monitorServices } from "#native/windows/bun/monitors";
import { Windows } from "#native/windows/bun/win32";
import { ole, user } from "#native/windows/bun/win32-bindings";
import { overlayIconProvider } from "#plugins/windows/src/platforms/windows-overlay-icon";
import { testAppMetadata } from "../fixtures/app-info.ts";
import { waitFor } from "../fixtures/deadlines.ts";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";
import { trayIco } from "../fixtures/tray-icon.ts";
import { windowPermissions } from "../fixtures/window-permissions.ts";

assert.equal(process.platform, "win32");
/** Real HWND placement beside synthetic reference rectangles; the hidden window and the foreground window stay as they were. */
async function verifyMoveNextToRect({
  area,
  outer,
  centered,
  foreground,
}: {
  area: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  outer: {
    x: number;
    y: number;
  };
  centered: {
    width: number;
    height: number;
  };
  foreground: unknown;
}) {
  const clampSpan = (value: number, start: number, span: number) =>
    Math.min(Math.max(value, start), start + span);
  const anchorRect = {
    x: area.x + Math.floor(area.width / 2),
    y: area.y + Math.floor(area.height / 2),
    width: 32,
    height: 32,
  };
  const edgeRect = {
    x: area.x + area.width - 48,
    y: area.y + area.height - 40,
    width: 32,
    height: 32,
  };
  const maxX = area.width - centered.width;
  const maxY = area.height - centered.height;
  for (const [rect, placement, align, margin, x, y] of [
    [
      anchorRect,
      "right",
      "start",
      12,
      anchorRect.x + anchorRect.width + 12,
      anchorRect.y,
    ],
    [
      anchorRect,
      "left",
      "end",
      0,
      anchorRect.x - centered.width,
      anchorRect.y + anchorRect.height - centered.height,
    ],
    [
      anchorRect,
      "above",
      "center",
      12,
      anchorRect.x + Math.round((anchorRect.width - centered.width) / 2),
      anchorRect.y - 12 - centered.height,
    ],
    [
      edgeRect,
      "below",
      "center",
      0,
      edgeRect.x + Math.round((edgeRect.width - centered.width) / 2),
      edgeRect.y + edgeRect.height,
    ],
    [
      edgeRect,
      "right",
      "end",
      0,
      edgeRect.x + edgeRect.width,
      edgeRect.y + edgeRect.height - centered.height,
    ],
  ] as const) {
    await windows.setPosition({
      x: outer.x,
      y: outer.y,
    });
    assert.equal(
      await windows.moveNextToRect({
        rect,
        placement,
        align,
        margin,
      }),
      null,
    );
    assert.deepEqual(
      {
        ...(await windows.getOuterBounds()),
      },
      {
        ...centered,
        x: clampSpan(x, area.x, maxX),
        y: clampSpan(y, area.y, maxY),
      },
    );
  }
  await windows.setPosition({
    x: outer.x,
    y: outer.y,
  });
  await windows.moveNextToRect({
    rect: anchorRect,
    placement: "below",
  });
  assert.deepEqual(
    {
      ...(await windows.getOuterBounds()),
    },
    {
      ...centered,
      x: clampSpan(
        anchorRect.x + Math.round((anchorRect.width - centered.width) / 2),
        area.x,
        maxX,
      ),
      y: clampSpan(anchorRect.y + anchorRect.height, area.y, maxY),
    },
  );
  await assert.rejects(
    windows.moveNextToRect({
      rect: {
        ...anchorRect,
        width: -1,
      },
      placement: "below",
    }),
  );
  assert.equal(await windows.isVisible(), false);
  assert.equal(user.symbols.GetForegroundWindow(), foreground);
}

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
        "test.hold",
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
  await writeFile(
    resolve(assets, "web/index.html"),
    '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'"><script type="module" src="app.js"></script>',
  );
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
    // POINT is passed by value as one 64-bit register: x in the low half, y in the high half.
    WindowFromPoint: {
      args: [
        "i64",
      ],
      returns: "u64",
    },
    GetAncestor: {
      args: [
        "u64",
        "u32",
      ],
      returns: "u64",
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
  checkHresult(ole.symbols.CoInitializeEx(null, 2), "CoInitializeEx(STA)");
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
        // A requested close is posted and reaches the window handler like a caption close, and a
        // window that is not closable drops it.
        nativeWindows.requestClose(hwnd);
        assert.equal(closeRequests, 1);
        nativeWindows.pump();
        assert.equal(closeRequests, 2);
        nativeWindows.setClosable(hwnd, false);
        nativeWindows.requestClose(hwnd);
        nativeWindows.pump();
        assert.equal(closeRequests, 2);
        nativeWindows.setClosable(hwnd, true);
        assert.equal(nativeWindows.isVisible(hwnd), visible);
        assert.deepEqual(nativeWindows.getBounds(hwnd, "outer"), original);
      } finally {
        nativeWindows.destroy(hwnd);
      }
      assert.throws(() => nativeWindows.isClosable(hwnd));
    }
    {
      const hwnd = nativeWindows.create(
        "Fullscreenable regression",
        650,
        450,
        () => {},
      );
      try {
        const original = nativeWindows.getBounds(hwnd, "outer");
        assert.equal(nativeWindows.isFullscreenable(hwnd), true);
        nativeWindows.setFullscreenable(hwnd, false);
        assert.equal(nativeWindows.isFullscreenable(hwnd), false);
        // The native layer rejects entering and leaves the window untouched.
        assert.throws(
          () => nativeWindows.setFullscreen(hwnd, true),
          (error) =>
            (
              error as {
                code?: string;
              }
            ).code === "INVALID_ARGUMENT",
        );
        assert.equal(nativeWindows.isFullscreen(hwnd), false);
        assert.deepEqual(nativeWindows.getBounds(hwnd, "outer"), original);
        // It is independent of the native maximize button.
        assert.equal(nativeWindows.isMaximizable(hwnd), true);
        nativeWindows.setFullscreenable(hwnd, true);
        nativeWindows.setFullscreen(hwnd, true);
        assert.equal(nativeWindows.isFullscreen(hwnd), true);
        // Disabling while fullscreen keeps the state, and leaving stays allowed.
        nativeWindows.setFullscreenable(hwnd, false);
        assert.equal(nativeWindows.isFullscreen(hwnd), true);
        nativeWindows.setFullscreen(hwnd, false);
        assert.equal(nativeWindows.isFullscreen(hwnd), false);
        assert.deepEqual(nativeWindows.getBounds(hwnd, "outer"), original);
        assert.throws(() => nativeWindows.setFullscreen(hwnd, true));
        nativeWindows.setFullscreenable(hwnd, true);
        nativeWindows.setFullscreen(hwnd, true);
        nativeWindows.setFullscreen(hwnd, false);
      } finally {
        nativeWindows.destroy(hwnd);
      }
      assert.throws(() => nativeWindows.isFullscreenable(hwnd));
    }
    {
      const custom = nativeWindows.create(
        "Shadow custom",
        500,
        400,
        () => {},
        true,
        {
          titlebar: "custom",
        },
      );
      const system = nativeWindows.create("Shadow system", 500, 400, () => {});
      try {
        // A native title bar always has its shadow: asking for it is a no-op and removing
        // it is rejected without changing anything.
        assert.equal(nativeWindows.hasShadow(system), true);
        nativeWindows.setHasShadow(system, true);
        assert.throws(
          () => nativeWindows.setHasShadow(system, false),
          (error) =>
            error instanceof BunawayError && error.code === "UNSUPPORTED",
        );
        assert.equal(nativeWindows.hasShadow(system), true);

        nativeWindows.setPosition(custom, 300, 200);
        nativeWindows.show(custom, true);
        const bounds = nativeWindows.getBounds(custom, "outer");
        const client = nativeWindows.getBounds(custom, "content");
        assert.equal(nativeWindows.hasShadow(custom), true);
        // The shadow is composed by DWM outside the GDI surface, so a screen capture cannot
        // see it; the state read back from DWM is what this test can check. Geometry,
        // visibility and opacity are not part of the shadow setting.
        nativeWindows.setHasShadow(custom, false);
        assert.equal(nativeWindows.hasShadow(custom), false);
        assert.deepEqual(nativeWindows.getBounds(custom, "outer"), bounds);
        assert.deepEqual(nativeWindows.getBounds(custom, "content"), client);
        assert.equal(nativeWindows.isVisible(custom), true);
        assert.equal(nativeWindows.getOpacity(custom), 1);
        nativeWindows.setHasShadow(custom, false);
        assert.equal(nativeWindows.hasShadow(custom), false);
        nativeWindows.setHasShadow(custom, true);
        assert.equal(nativeWindows.hasShadow(custom), true);
        assert.deepEqual(nativeWindows.getBounds(custom, "outer"), bounds);

        // The corner preference is a DWM hint with no read-back, so the requested value is the
        // state. The call succeeds on every Windows build (builds before 11 ignore it; see
        // cornerPreferenceIgnored), and geometry, visibility and the shadow setting are not part of it. A native title bar
        // window keeps the system default: squaring it is rejected, asking for round is a no-op.
        assert.equal(nativeWindows.hasRoundedCorners(custom), true);
        nativeWindows.setRoundedCorners(custom, false);
        assert.equal(nativeWindows.hasRoundedCorners(custom), false);
        nativeWindows.setRoundedCorners(custom, false);
        assert.equal(nativeWindows.hasRoundedCorners(custom), false);
        nativeWindows.setHasShadow(custom, false);
        nativeWindows.setRoundedCorners(custom, true);
        assert.equal(nativeWindows.hasRoundedCorners(custom), true);
        assert.equal(nativeWindows.hasShadow(custom), false);
        nativeWindows.setHasShadow(custom, true);
        assert.deepEqual(nativeWindows.getBounds(custom, "outer"), bounds);
        assert.equal(nativeWindows.isVisible(custom), true);
        assert.equal(nativeWindows.hasRoundedCorners(system), true);
        nativeWindows.setRoundedCorners(system, true);
        assert.throws(
          () => nativeWindows.setRoundedCorners(system, false),
          (error) =>
            error instanceof BunawayError && error.code === "UNSUPPORTED",
        );
        assert.equal(nativeWindows.hasRoundedCorners(system), true);

        // The backdrop material is a DWM hint with no read-back, so the requested value is the
        // state. The calls succeed on every Windows build (builds before 22H2 skip the DWM call, which
        // is all this runner exercises; see backdropSupported), for native and custom title
        // bars alike, and leave geometry alone.
        for (const target of [
          system,
          custom,
        ]) {
          assert.equal(nativeWindows.getBackgroundMaterial(target), "auto");
          for (const material of [
            "mica",
            "acrylic",
            "tabbed",
            "none",
            "auto",
          ] as const) {
            nativeWindows.setBackgroundMaterial(target, material);
            assert.equal(nativeWindows.getBackgroundMaterial(target), material);
          }
        }
        nativeWindows.setBackgroundMaterial(custom, "mica");
        assert.equal(nativeWindows.getBackgroundMaterial(system), "auto");
        assert.deepEqual(nativeWindows.getBounds(custom, "outer"), bounds);
        assert.equal(nativeWindows.isVisible(custom), true);
      } finally {
        nativeWindows.destroy(system);
        nativeWindows.destroy(custom);
      }
      assert.throws(() => nativeWindows.getBackgroundMaterial(custom));
      assert.throws(() => nativeWindows.setBackgroundMaterial(custom, "mica"));
      assert.throws(() => nativeWindows.hasShadow(custom));
      assert.throws(() => nativeWindows.setHasShadow(custom, false));
      assert.throws(() => nativeWindows.hasRoundedCorners(custom));
      assert.throws(() => nativeWindows.setRoundedCorners(custom, false));
    }
    {
      const gdi = dlopen("gdi32.dll", {
        CreateCompatibleDC: {
          args: [
            "u64",
          ],
          returns: "u64",
        },
        CreateCompatibleBitmap: {
          args: [
            "u64",
            "i32",
            "i32",
          ],
          returns: "u64",
        },
        SelectObject: {
          args: [
            "u64",
            "u64",
          ],
          returns: "u64",
        },
        SetPixelV: {
          args: [
            "u64",
            "i32",
            "i32",
            "u32",
          ],
          returns: "i32",
        },
        GetPixel: {
          args: [
            "u64",
            "i32",
            "i32",
          ],
          returns: "u32",
        },
        DeleteObject: {
          args: [
            "u64",
          ],
          returns: "i32",
        },
        DeleteDC: {
          args: [
            "u64",
          ],
          returns: "i32",
        },
      });
      const messaging = dlopen("user32.dll", {
        GetDC: {
          args: [
            "u64",
          ],
          returns: "u64",
        },
        ReleaseDC: {
          args: [
            "u64",
            "u64",
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
      });
      const WM_ERASEBKGND = 0x0014;
      /** A COLORREF no window color in this test uses, so an erase that paints nothing stays visible. */
      const SENTINEL = 0x123456;
      /** Send WM_ERASEBKGND with a memory DC holding the sentinel and read back the COLORREF at the top-left pixel. */
      const erasedPixel = (
        hwnd: bigint,
      ): {
        handled: bigint;
        pixel: number;
      } => {
        const screen = messaging.symbols.GetDC(0n);
        const memory = gdi.symbols.CreateCompatibleDC(screen);
        const bitmap = gdi.symbols.CreateCompatibleBitmap(screen, 500, 400);
        const previous = gdi.symbols.SelectObject(memory, bitmap);
        try {
          gdi.symbols.SetPixelV(memory, 1, 1, SENTINEL);
          const handled = messaging.symbols.SendMessageW(
            hwnd,
            WM_ERASEBKGND,
            memory,
            0n,
          );
          return {
            handled,
            pixel: gdi.symbols.GetPixel(memory, 1, 1),
          };
        } finally {
          gdi.symbols.SelectObject(memory, previous);
          gdi.symbols.DeleteObject(bitmap);
          gdi.symbols.DeleteDC(memory);
          messaging.symbols.ReleaseDC(0n, screen);
        }
      };
      const painted = nativeWindows.create(
        "Background painted",
        500,
        400,
        () => {},
        true,
        {
          backgroundColor: "#203040",
        },
      );
      const plain = nativeWindows.create(
        "Background plain",
        500,
        400,
        () => {},
      );
      try {
        assert.equal(nativeWindows.getBackgroundColor(painted), "#203040");
        assert.equal(nativeWindows.getBackgroundColor(plain), null);
        // COLORREF is 0x00BBGGRR.
        assert.deepEqual(erasedPixel(painted), {
          handled: 1n,
          pixel: 0x403020,
        });
        nativeWindows.setBackgroundColor(painted, "#a1b2c3");
        assert.equal(nativeWindows.getBackgroundColor(painted), "#a1b2c3");
        assert.deepEqual(erasedPixel(painted), {
          handled: 1n,
          pixel: 0xc3b2a1,
        });
        // A window with no color keeps the class brush and its own erase result.
        assert.equal(nativeWindows.getBackgroundColor(plain), null);
        // The default procedure paints the class brush over the sentinel instead of leaving it.
        const unpainted = erasedPixel(plain);
        assert.notEqual(unpainted.pixel, SENTINEL);
        assert.notEqual(unpainted.pixel, 0xc3b2a1);
        assert.notEqual(unpainted.pixel, 0x403020);
        nativeWindows.setBackgroundColor(plain, "#010203");
        assert.equal(erasedPixel(plain).pixel, 0x030201);
        assert.equal(nativeWindows.getBackgroundColor(painted), "#a1b2c3");
      } finally {
        nativeWindows.destroy(plain);
        nativeWindows.destroy(painted);
        gdi.close();
        messaging.close();
      }
      assert.throws(() => nativeWindows.getBackgroundColor(painted));
      assert.throws(() => nativeWindows.setBackgroundColor(painted, "#010203"));
    }
    {
      // A transparent window composes alpha 0 over the desktop: a red window below it must show
      // through, which a window that is merely erased with the system brush would hide.
      const screen = dlopen("gdi32.dll", {
        GetPixel: {
          args: [
            "u64",
            "i32",
            "i32",
          ],
          returns: "u32",
        },
      });
      const screenDc = dlopen("user32.dll", pick(USER32, "GetDC", "ReleaseDC"));
      /** GetAncestor flag for the top-level window. */
      const GA_ROOT = 2;
      /** COLORREF 0x00BBGGRR of the red window below the transparent one. */
      const RED = 0x0000ff;
      /** COLORREF 0x00BBGGRR of the opaque control window. */
      const GREEN = 0x00ff00;
      const area = {
        x: 120,
        y: 120,
      };
      const below = nativeWindows.create(
        "Transparent below",
        300,
        300,
        () => {},
        true,
        {
          ...area,
          backgroundColor: "#ff0000",
          titlebar: "custom",
        },
      );
      const clear = nativeWindows.create(
        "Transparent window",
        300,
        300,
        () => {},
        true,
        {
          ...area,
          titlebar: "custom",
          transparent: true,
        },
      );
      const opaque = nativeWindows.create(
        "Opaque control",
        300,
        300,
        () => {},
        true,
        {
          x: 520,
          y: 120,
          titlebar: "custom",
          backgroundColor: "#00ff00",
        },
      );
      try {
        assert.equal(nativeWindows.getBackgroundColor(clear), null);
        assert.throws(
          () => nativeWindows.setBackgroundColor(clear, "#112233"),
          (error) =>
            error instanceof BunawayError && error.code === "UNSUPPORTED",
        );
        assert.throws(
          () => nativeWindows.setBackgroundMaterial(clear, "mica"),
          (error) =>
            error instanceof BunawayError && error.code === "UNSUPPORTED",
        );
        nativeWindows.setBackgroundMaterial(clear, "none");
        assert.equal(nativeWindows.getBackgroundMaterial(clear), "none");
        const dc = screenDc.symbols.GetDC(0n);
        try {
          const bounds = nativeWindows.getBounds(clear, "outer");
          const x = bounds.x + Math.floor(bounds.width / 2);
          const y = bounds.y + Math.floor(bounds.height / 2);
          // The red pixel only proves transparency if the transparent window is the one on top.
          await waitFor(
            () => {
              nativeWindows.pump();
              // POINT is passed by value as one 64-bit register: x in the low half, y in the high half.
              const hit = driver.symbols.WindowFromPoint(
                BigInt.asIntN(
                  64,
                  (BigInt(y) << 32n) | (BigInt(x) & 0xffff_ffffn),
                ),
              );
              return (
                hit !== 0n &&
                driver.symbols.GetAncestor(hit, GA_ROOT) === BigInt(clear)
              );
            },
            {
              deadline: "inProcess",
              what: "the transparent window to be the top window at the probe point",
            },
          );
          await waitFor(
            () => {
              nativeWindows.pump();
              return screen.symbols.GetPixel(dc, x, y) === RED;
            },
            {
              deadline: "inProcess",
              what: "the red window to show through the transparent window",
            },
          );
          const control = nativeWindows.getBounds(opaque, "outer");
          const controlX = control.x + Math.floor(control.width / 2);
          const controlY = control.y + Math.floor(control.height / 2);
          // Opacity and click-through turn on the layered style; the per-pixel alpha must still
          // compose, so the red window stays visible instead of a dimmed black fill.
          for (const toggle of [
            () => nativeWindows.setOpacity(clear, 0.5),
            () => nativeWindows.setOpacity(clear, 1),
            () => nativeWindows.setIgnoreMouseEvents(clear, true),
            () => nativeWindows.setIgnoreMouseEvents(clear, false),
          ]) {
            toggle();
            // Dimming and restoring the control window shows DWM has composed a frame after the
            // toggle, so the single read below cannot see the frame from before it.
            nativeWindows.setOpacity(opaque, 0.5);
            await waitFor(
              () => {
                nativeWindows.pump();
                return (
                  screen.symbols.GetPixel(dc, controlX, controlY) !== GREEN
                );
              },
              {
                deadline: "inProcess",
                what: "DWM to compose the dimmed control window",
              },
            );
            nativeWindows.setOpacity(opaque, 1);
            await waitFor(
              () => {
                nativeWindows.pump();
                return (
                  screen.symbols.GetPixel(dc, controlX, controlY) === GREEN
                );
              },
              {
                deadline: "inProcess",
                what: "DWM to compose the restored control window",
              },
            );
            assert.equal(
              screen.symbols.GetPixel(dc, x, y),
              RED,
              "the red window stays visible after a layered style change",
            );
          }
          await waitFor(
            () => {
              nativeWindows.pump();
              return screen.symbols.GetPixel(dc, controlX, controlY) === GREEN;
            },
            {
              deadline: "inProcess",
              what: "the opaque control window to paint its color",
            },
          );
        } finally {
          screenDc.symbols.ReleaseDC(0n, dc);
        }
      } finally {
        nativeWindows.destroy(opaque);
        nativeWindows.destroy(clear);
        nativeWindows.destroy(below);
        screen.close();
        screenDc.close();
      }
      // A destroyed window is forgotten as transparent, so the error is the closed-window one
      // rather than the transparent-window UNSUPPORTED.
      assert.throws(
        () => nativeWindows.setBackgroundColor(clear, "#010203"),
        (error) =>
          !(error instanceof BunawayError && error.code === "UNSUPPORTED"),
      );
    }
    {
      const hwnd = nativeWindows.create(
        "Opacity regression",
        650,
        450,
        () => {},
      );
      try {
        const original = nativeWindows.getBounds(hwnd, "outer");
        assert.equal(nativeWindows.getOpacity(hwnd), 1);
        // The OS stores 8-bit alpha, so a set value reads back within one step.
        nativeWindows.setOpacity(hwnd, 0.5);
        assert.ok(Math.abs(nativeWindows.getOpacity(hwnd) - 0.5) <= 1 / 255);
        nativeWindows.setOpacity(hwnd, 0);
        assert.equal(nativeWindows.getOpacity(hwnd), 0);
        // Changing opacity leaves geometry and visibility alone, and works while shown.
        nativeWindows.show(hwnd, true);
        nativeWindows.setOpacity(hwnd, 0.25);
        assert.ok(Math.abs(nativeWindows.getOpacity(hwnd) - 0.25) <= 1 / 255);
        assert.equal(nativeWindows.isVisible(hwnd), true);
        nativeWindows.setOpacity(hwnd, 1);
        assert.equal(nativeWindows.getOpacity(hwnd), 1);
        assert.deepEqual(nativeWindows.getBounds(hwnd, "outer"), original);
        for (const invalid of [
          -0.1,
          1.1,
          Number.NaN,
        ]) {
          assert.throws(() => nativeWindows.setOpacity(hwnd, invalid));
        }
        assert.equal(nativeWindows.getOpacity(hwnd), 1);
      } finally {
        nativeWindows.destroy(hwnd);
      }
      assert.throws(() => nativeWindows.getOpacity(hwnd));
    }
    {
      const rootAt = (x: number, y: number) => {
        const point = (BigInt(y) << 32n) | (BigInt(x) & 0xffff_ffffn);
        const hit = driver.symbols.WindowFromPoint(BigInt.asIntN(64, point));
        return hit === 0n ? 0n : driver.symbols.GetAncestor(hit, 2);
      };
      const under = nativeWindows.create(
        "Click-through under",
        500,
        400,
        () => {},
      );
      const over = nativeWindows.create(
        "Click-through over",
        500,
        400,
        () => {},
      );
      try {
        nativeWindows.setPosition(under, 120, 120);
        nativeWindows.setPosition(over, 120, 120);
        nativeWindows.show(under, true);
        nativeWindows.show(over, true);
        const bounds = nativeWindows.getBounds(over, "outer");
        const x = bounds.x + Math.floor(bounds.width / 2);
        const y = bounds.y + Math.floor(bounds.height / 2);
        assert.equal(nativeWindows.isIgnoreMouseEvents(over), false);
        assert.equal(rootAt(x, y), over);
        nativeWindows.setIgnoreMouseEvents(over, true);
        assert.equal(nativeWindows.isIgnoreMouseEvents(over), true);
        // The window stays visible and opaque but input reaches the window beneath.
        assert.equal(nativeWindows.isVisible(over), true);
        assert.equal(nativeWindows.getOpacity(over), 1);
        assert.equal(rootAt(x, y), under);
        // Opacity shares the layered style: full opacity keeps click-through, and
        // releasing click-through keeps a translucent window layered.
        nativeWindows.setOpacity(over, 0.5);
        nativeWindows.setOpacity(over, 1);
        assert.equal(nativeWindows.isIgnoreMouseEvents(over), true);
        assert.equal(rootAt(x, y), under);
        nativeWindows.setOpacity(over, 0.5);
        nativeWindows.setIgnoreMouseEvents(over, false);
        assert.ok(Math.abs(nativeWindows.getOpacity(over) - 0.5) <= 1 / 255);
        assert.equal(rootAt(x, y), over);
        nativeWindows.setOpacity(over, 1);
        assert.equal(nativeWindows.getOpacity(over), 1);
        // Repeating either state is a no-op, and a window that ignored the mouse is
        // an ordinary opaque window again once both settings are cleared.
        nativeWindows.setIgnoreMouseEvents(over, false);
        nativeWindows.setIgnoreMouseEvents(over, true);
        nativeWindows.setIgnoreMouseEvents(over, true);
        nativeWindows.setIgnoreMouseEvents(over, false);
        assert.equal(nativeWindows.isIgnoreMouseEvents(over), false);
        assert.equal(rootAt(x, y), over);
        assert.deepEqual(nativeWindows.getBounds(over, "outer"), bounds);
      } finally {
        nativeWindows.destroy(over);
        nativeWindows.destroy(under);
      }
      assert.throws(() => nativeWindows.isIgnoreMouseEvents(over));
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
    // Window icons: WM_SETICON through the real HWND for the small and big sizes in every visibility and
    // placement state, and no leaked USER objects over repeated replacement and clearing.
    {
      const gui = dlopen("user32.dll", {
        GetGuiResources: {
          args: [
            "u64",
            "u32",
          ],
          returns: "u32",
        },
      });
      const kernel = dlopen("kernel32.dll", {
        GetCurrentProcess: {
          args: [],
          returns: "u64",
        },
      });
      const userObjects = () =>
        gui.symbols.GetGuiResources(kernel.symbols.GetCurrentProcess(), 1);
      const WM_GETICON = 0x7f;
      const ICON_SMALL = 0n;
      const ICON_BIG = 1n;
      const iconOf = (hwnd: bigint, size: bigint) =>
        driver.symbols.SendMessageW(hwnd, WM_GETICON, size, 0n);
      for (const state of [
        "shown",
        "hidden",
        "minimized",
        "no-taskbar",
      ]) {
        const hwnd = nativeWindows.create("Window icon", 400, 300, () => {});
        try {
          if (state === "hidden") {
            nativeWindows.show(hwnd, false);
          }
          if (state === "minimized") {
            user.symbols.ShowWindow(hwnd, 2);
          }
          if (state === "no-taskbar") {
            // skipTaskbar can only change while the window is hidden.
            nativeWindows.show(hwnd, false);
            nativeWindows.setSkipTaskbar(hwnd, true);
            nativeWindows.show(hwnd, true);
          }
          const initial = [
            iconOf(hwnd, ICON_SMALL),
            iconOf(hwnd, ICON_BIG),
          ];
          assert.equal(nativeWindows.hasWindowIcon(hwnd), false);
          nativeWindows.setWindowIcon(
            hwnd,
            overlayIconProvider(trayIco(16).toString("base64"), "window"),
          );
          assert.equal(nativeWindows.hasWindowIcon(hwnd), true);
          const small = iconOf(hwnd, ICON_SMALL);
          const big = iconOf(hwnd, ICON_BIG);
          assert(small && big && small !== initial[0] && big !== initial[1]);
          // A rejected image keeps the current icon.
          assert.throws(() =>
            nativeWindows.setWindowIcon(hwnd, () => {
              throw new Error("rejected");
            }),
          );
          assert.equal(iconOf(hwnd, ICON_SMALL), small);
          // A failure while building the big icon keeps both current icons and releases the small one.
          let providerCalls = 0;
          assert.throws(() =>
            nativeWindows.setWindowIcon(hwnd, (sizePx) => {
              if (++providerCalls === 2) {
                throw new Error("rejected big icon");
              }
              return overlayIconProvider(
                trayIco(16).toString("base64"),
                "window",
              )(sizePx);
            }),
          );
          assert.equal(iconOf(hwnd, ICON_SMALL), small);
          assert.equal(iconOf(hwnd, ICON_BIG), big);
          nativeWindows.setWindowIcon(
            hwnd,
            overlayIconProvider(trayIco(32).toString("base64"), "window"),
          );
          assert.notEqual(iconOf(hwnd, ICON_SMALL), small);
          // Back to the class icon, and clearing twice is harmless.
          nativeWindows.setWindowIcon(hwnd, null);
          nativeWindows.setWindowIcon(hwnd, null);
          assert.equal(nativeWindows.hasWindowIcon(hwnd), false);
          assert.deepEqual(
            [
              iconOf(hwnd, ICON_SMALL),
              iconOf(hwnd, ICON_BIG),
            ],
            initial,
          );
          const provider = overlayIconProvider(
            trayIco(16).toString("base64"),
            "window",
          );
          const before = userObjects();
          for (let index = 0; index < 100; index++) {
            nativeWindows.setWindowIcon(hwnd, provider);
          }
          nativeWindows.setWindowIcon(hwnd, null);
          assert(userObjects() <= before + 2, "Window icon leaked HICONs");
          // An icon still set at destroy is released after DestroyWindow; destroy must not throw.
          nativeWindows.setWindowIcon(hwnd, provider);
        } finally {
          nativeWindows.destroy(hwnd);
        }
        assert.throws(() => nativeWindows.hasWindowIcon(hwnd));
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
    windowCreations = 0,
    geometry = false,
    pending = "";
  const windowChecks: Promise<void>[] = [];
  const decoder = new TextDecoder();
  const timers = new Set<ReturnType<typeof setInterval>>();
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
          if (event.event === "window-created") {
            handles.set(event.view, BigInt(event.hwnd));
            if (++windowCreations > 3) {
              child.kill();
              throw new Error("Recreation opened an unexpected extra window.");
            }
          }
          if (event.event === "window-api-geometry") {
            const hwnd = handles.get("main");
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
            const answer = ++confirmations === 1 ? 7n : 6n; // IDNO
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
    await Promise.all(windowChecks);
    assert.equal(code, 0, await errors);
    assert.equal(confirmations, 2);
    assert(geometry);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.pass, true);
    assert.equal(windowCreations, 3);
    assert.equal(report.revokedDocuments, true);
    console.log(
      "PASS Windows public window API: window identity, navigation identity preservation, native recreation identity replacement, destroyed and normal state, size constraints, GetDpiForWindow scaling at the current monitor, maximize and restore, fullscreen visibility, geometry, close refusal, recreation with options, fresh sessions and revoked documents",
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
    holds = 0,
    cancellations = 0,
    quitAttempts = 0;
  let mainWindowId = "";
  /** Waits for state changes reported by separate WebView documents. */
  async function waitFor(check: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 10000;
    while (!(await check())) {
      assert(Date.now() < deadline, "Fresh document did not connect");
      await Bun.sleep(10);
    }
  }
  /** Run 2 follows a navigation of the same window; later runs follow a recreation. */
  function assertIdentity(run: number, windowId: string) {
    if (run === 2) {
      assert.equal(
        windowId,
        mainWindowId,
        "navigation preserves native identity",
      );
    } else if (run > 2) {
      assert.notEqual(
        windowId,
        mainWindowId,
        "native recreation replaces identity",
      );
    }
    mainWindowId = windowId;
  }
  /** Run 4 follows a recreation without options, which restores the declaration. */
  async function verifyRecreatedDeclaration(run: number) {
    assert.equal(run, 4);
    // Recreation starts from the declaration, not from the previous runtime state.
    assert.equal(await windows.getBackgroundColor(), "#112233");
    assert.equal(await windows.isFocusable(), true);
    assert.equal(await windows.isMinimizable(), true);
    assert.equal(await windows.isMaximizable(), true);
    assert.equal(await windows.isClosable(), true);
    assert.equal(await windows.isFullscreenable(), true);
    assert.equal(await windows.getTitle(), "Window API editor");
    assert.deepEqual(
      {
        ...(await windows.getSizeConstraints()),
      },
      {
        minWidth: 500,
        minHeight: 400,
        maxWidth: 800,
        maxHeight: 600,
      },
    );
    assert.equal(quitAttempts, 0, "recreation must bypass app quit checks");
    await writeFile(
      reportPath,
      JSON.stringify({
        pass: true,
        cancellations,
        revokedDocuments: cancellations >= 2,
        navigationPreservesIdentity: true,
      }),
    );
    // Closing the only window ends the app; the quit check approves it.
    await windows.close();
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
      beforeQuit: () => {
        quitAttempts++;
        return true;
      },
    },
    commands: {
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
          const run = ++runs;
          const snapshot = await windows.getSnapshot();
          // Every document connects once; recreation revokes the previous document's pending call.
          await waitFor(() => holds === run && cancellations >= run - 2);
          const monitors = await windows.getMonitors();
          assert(monitors.length > 0);
          const primary = await windows.getPrimaryMonitor();
          assert(
            primary.primary &&
              monitors.some((monitor) => monitor.id === primary.id),
          );
          const monitor = await windows.getMonitor();
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
          assertIdentity(run, snapshot.windowId);
          if (run !== 3) {
            // Exercise the public plugin, actual UI STA and ITaskbarList3 on each native lifetime.
            // Explorer creates buttons asynchronously; WebView readiness does not imply button readiness.
            await waitFor(async () => {
              try {
                await windows.setTaskbarProgress({
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
                  state,
                  value: 0.375,
                }),
                null,
              );
            }
            assert.equal(
              await windows.setTaskbarProgress({
                state: "none",
              }),
              null,
            );
            // The button exists now, so thumbnail calls reach the real ITaskbarList3.
            assert.equal(
              await windows.setThumbnailClip({
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
            await windows.minimize();
            assert.equal(await windows.isMinimized(), true);
            assert.equal(
              await windows.setThumbnailClip({
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
            await windows.restore();
            assert.equal(await windows.isMinimized(), false);
            // Minimizing from maximized restores to a larger area, so no upper bound is checked then.
            await windows.maximize();
            await windows.minimize();
            assert.equal(
              await windows.setThumbnailClip({
                region: {
                  x: 0,
                  y: 0,
                  width: 100,
                  height: 80,
                },
              }),
              null,
            );
            await windows.restore();
            assert.equal(await windows.isMaximized(), true);
            await windows.unmaximize();
            assert.equal(await windows.isMaximized(), false);
            // Beyond the client area the region is clamped; one starting outside it is empty and rejected.
            assert.equal(
              await windows.setThumbnailClip({
                region: {
                  x: 0,
                  y: 0,
                  width: 100_000,
                  height: 80,
                },
              }),
              null,
            );
            await assert.rejects(
              windows.setThumbnailClip({
                region: {
                  x: 100_000,
                  y: 0,
                  width: 100,
                  height: 80,
                },
              }),
              {
                code: "INVALID_ARGUMENT",
              },
            );
            assert.equal(
              await windows.setThumbnailClip({
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
                  toolTip,
                }),
                null,
              );
            }
            // Set, replace (which releases the previous HICON) and remove the overlay through the real ITaskbarList3.
            for (const [ico, description] of [
              [
                trayIco(16),
                "3 unread",
              ],
              [
                trayIco(32),
                "",
              ],
              [
                null,
                "ignored",
              ],
            ] as const) {
              assert.equal(
                await windows.setOverlayIcon({
                  ico: ico?.toString("base64") ?? null,
                  description,
                }),
                null,
              );
            }
            // A rejected image keeps the current overlay and reports an argument error, not a shell failure.
            await assert.rejects(
              windows.setOverlayIcon({
                ico: Buffer.alloc(64).toString("base64"),
                description: "bad",
              }),
              {
                code: "INVALID_ARGUMENT",
              },
            );
            // The thumbnail toolbar adds seven slots once, then changes the visible buttons through updates.
            const toolbarIco = trayIco(16).toString("base64");
            const toolbarButton = (id: string) => ({
              id,
              ico: toolbarIco,
              tooltip: id,
            });
            for (const buttons of [
              [],
              [
                toolbarButton("prev"),
                toolbarButton("play"),
                toolbarButton("next"),
              ],
              [
                toolbarButton("play"),
              ],
              Array.from(
                {
                  length: 7,
                },
                (_, index) => toolbarButton(`b${index}`),
              ),
              [],
            ]) {
              assert.equal(
                await windows.setThumbnailToolbar({
                  buttons,
                }),
                null,
              );
            }
            // A rejected image keeps the current toolbar and reports an argument error, not a shell failure.
            await assert.rejects(
              windows.setThumbnailToolbar({
                buttons: [
                  {
                    id: "bad",
                    ico: Buffer.alloc(64).toString("base64"),
                  },
                ],
              }),
              {
                code: "INVALID_ARGUMENT",
              },
            );
            await assert.rejects(
              windows.setThumbnailToolbar({
                buttons: [
                  toolbarButton("dup"),
                  toolbarButton("dup"),
                ],
              }),
              {
                code: "INVALID_ARGUMENT",
              },
            );
          }
          // Run 1 ends with the page navigating within the same window. Run 2 recreates the window
          // with options, run 3 verifies them and the rest of the API, and run 4 verifies that
          // recreation restores the declaration.
          switch (run) {
            case 1:
              assert.equal(await windows.isOpen(), true);
              break;
            case 2:
              await windows.recreate({
                options: {
                  window: {
                    focusable: false,
                    maximized: true,
                    fullscreen: true,
                  },
                  visible: false,
                },
              });
              break;
            case 3: {
              assert.equal(await windows.isFullscreen(), true);
              assert.equal(await windows.isMaximized(), true);
              assert.equal(await windows.isVisible(), false);
              await windows.setFullscreen({
                fullscreen: false,
              });
              assert.equal(await windows.isMaximized(), true);
              assert.equal(await windows.isVisible(), false);
              await windows.unmaximize();
              assert.deepEqual(
                {
                  ...(await windows.getSizeConstraints()),
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
                  ...(await windows.getMinSize()),
                },
                {
                  width: 500,
                  height: 400,
                },
              );
              assert.deepEqual(
                {
                  ...(await windows.getMaxSize()),
                },
                {
                  width: 800,
                  height: 600,
                },
              );
              await assertContentSize(500, 600);
              console.log(
                JSON.stringify({
                  event: "window-api-focusability",
                }),
              );
              assert.equal(await windows.isFocusable(), false);
              await windows.setFocusable({
                focusable: true,
              });
              assert.equal(await windows.isFocusable(), true);
              await windows.setFocusable({
                focusable: false,
              });
              assert.equal(await windows.isFocusable(), false);
              await windows.setMinimizable({
                minimizable: false,
              });
              await windows.setMaximizable({
                maximizable: false,
              });
              await windows.setClosable({
                closable: false,
              });
              assert.equal(await windows.isMinimizable(), false);
              assert.equal(await windows.isMaximizable(), false);
              assert.equal(await windows.isClosable(), false);
              assert.equal(await windows.getTitle(), "Window API editor");
              await windows.setTitle({
                title: "수정된 제목 📝",
              });
              assert.equal(await windows.getTitle(), "수정된 제목 📝");
              await assert.rejects(
                windows.setTitle({
                  title: "invalid\0title",
                }),
                {
                  code: "INVALID_ARGUMENT",
                },
              );
              assert.equal(await windows.getTitle(), "수정된 제목 📝");
              // The driver verifies that close confirmation uses this runtime caption.
              assert.equal(await windows.isOpen(), true);
              assert.equal(await windows.isNormal(), true);
              await windows.hide();
              assert.equal(await windows.activate(), false);
              await windows.showInactive();
              assert.equal(await windows.isVisible(), true);
              assert.equal(await windows.isFocused(), false);
              await windows.minimize();
              assert.equal(await windows.activate(), false);
              await windows.showInactive();
              assert.equal(await windows.isMinimized(), true);
              await windows.unmaximize();
              const activated = await windows.activate();
              assert.equal(activated, await windows.isFocused());
              assert.equal(await windows.isVisible(), true);
              assert.equal(await windows.isMinimized(), false);
              assert.equal(await windows.isMaximized(), false);
              console.log(
                JSON.stringify({
                  event: "window-api-maximize-history",
                }),
              );
              await windows.maximize();
              assert.equal(await windows.isNormal(), false);
              assert.equal(await windows.isMaximized(), true);
              await windows.minimize();
              assert.equal(await windows.isMinimized(), true);
              await windows.restore();
              assert.equal(await windows.isMaximized(), true);
              await windows.minimize();
              await windows.unmaximize();
              assert.equal(await windows.isMinimized(), false);
              assert.equal(await windows.isMaximized(), false);
              await windows.toggleMaximize();
              assert.equal(await windows.isMaximized(), true);
              await windows.toggleMaximize();
              assert.equal(await windows.isMaximized(), false);
              for (const name of [
                "minimize",
                "maximize",
                "unmaximize",
                "restore",
                "toggleMaximize",
              ] as const) {
                await windows.hide();
                assert.equal(await windows.isVisible(), false);
                assert.equal(await windows.isFocused(), false);
                await windows[name]();
                assert.equal(await windows.isVisible(), true);
                await windows.unmaximize();
              }
              console.log(
                JSON.stringify({
                  event: "window-api-state",
                }),
              );
              await assert.rejects(
                windows.create({}),
                (error: unknown) =>
                  (
                    error as {
                      code: string;
                    }
                  ).code === "BUSY",
              );
              await windows.hide();
              const foreground = user.symbols.GetForegroundWindow();
              // Read-only queries must not activate a hidden window.
              assert.equal(await windows.isOpen(), true);
              await windows.getReadiness();
              assert.equal(await windows.isVisible(), false);
              assert.equal(
                user.symbols.GetForegroundWindow(),
                foreground,
                "lookup must not activate a hidden window",
              );
              await windows.show();
              try {
                await windows.focus();
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
                width: 700,
                height: 550,
              });
              assert.equal(await windows.isResizable(), true);
              assert.equal(await windows.isMovable(), true);
              await windows.setResizable({
                resizable: false,
              });
              await windows.setMovable({
                movable: false,
              });
              assert.equal(await windows.isResizable(), false);
              assert.equal(await windows.isMovable(), false);
              // Programmatic geometry remains available while user interactions are disabled.
              await windows.setSize({
                width: 700,
                height: 550,
              });
              await windows.setPosition({
                x: 20,
                y: 30,
              });
              await windows.setResizable({
                resizable: true,
              });
              await windows.setMovable({
                movable: true,
              });
              assert.equal(await windows.getAspectRatio(), null);
              const beforeAspectRatio = await windows.getOuterBounds();
              await windows.setAspectRatio({
                ratio: 16 / 9,
              });
              assert.equal(await windows.getAspectRatio(), 16 / 9);
              // Setting the lock leaves the current size unchanged.
              assert.deepEqual(
                await windows.getOuterBounds(),
                beforeAspectRatio,
              );
              await assert.rejects(
                windows.setAspectRatio({
                  ratio: 0,
                }),
                {
                  code: "INVALID_ARGUMENT",
                },
              );
              assert.equal(await windows.getAspectRatio(), 16 / 9);
              await windows.setAspectRatio({
                ratio: null,
              });
              assert.equal(await windows.getAspectRatio(), null);
              // Verify the public API through the real core, UI worker and HWND.
              const content = await windows.getContentSize({
                unit: "logical",
              });
              assert.equal(content.width, 700);
              assert.equal(content.height, 550);
              assert.deepEqual(
                {
                  ...(await windows.getOuterPosition({})),
                },
                {
                  x: 20,
                  y: 30,
                  dpi: content.dpi,
                },
              );
              const outer = await windows.getOuterBounds({});
              await windows.hide();
              const centerForeground = user.symbols.GetForegroundWindow();
              await windows.center();
              const centered = await windows.getOuterBounds();
              assert.equal(centered.width, outer.width);
              assert.equal(centered.height, outer.height);
              assert.equal(await windows.isVisible(), false);
              assert.equal(
                user.symbols.GetForegroundWindow(),
                centerForeground,
              );
              await windows.center();
              assert.deepEqual(await windows.getOuterBounds(), centered);
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
                x: outer.x,
                y: outer.y,
              });
              await windows.center({
                monitorId: centerTarget.id,
              });
              assert.deepEqual(await windows.getOuterBounds(), centered);
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
              assert.equal(await windows.isVisible(), false);
              assert.equal(
                user.symbols.GetForegroundWindow(),
                centerForeground,
              );
              // Start off-center so a fallback to the current monitor cannot pass unnoticed.
              await windows.setPosition({
                x: outer.x,
                y: outer.y,
              });
              const movedBeforeReject = await windows.getOuterBounds();
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
                  monitorId: "\\\\.\\DISPLAY999",
                }),
                {
                  code: "INVALID_ARGUMENT",
                },
              );
              assert.deepEqual(
                await windows.getOuterBounds(),
                movedBeforeReject,
              );
              // Every anchor places the hidden window against its work-area edge, inset by margin.
              const anchorMargin = Math.round((12 * centerTarget.dpi) / 96);
              const anchorArea = centerTarget.workArea;
              const anchorLeft = anchorArea.x + anchorMargin;
              const anchorTop = anchorArea.y + anchorMargin;
              const anchorRight =
                anchorArea.x + anchorArea.width - centered.width - anchorMargin;
              const anchorBottom =
                anchorArea.y +
                anchorArea.height -
                centered.height -
                anchorMargin;
              for (const [anchor, x, y] of [
                [
                  "top-left",
                  anchorLeft,
                  anchorTop,
                ],
                [
                  "top",
                  centered.x,
                  anchorTop,
                ],
                [
                  "top-right",
                  anchorRight,
                  anchorTop,
                ],
                [
                  "left",
                  anchorLeft,
                  centered.y,
                ],
                [
                  "center",
                  centered.x,
                  centered.y,
                ],
                [
                  "right",
                  anchorRight,
                  centered.y,
                ],
                [
                  "bottom-left",
                  anchorLeft,
                  anchorBottom,
                ],
                [
                  "bottom",
                  centered.x,
                  anchorBottom,
                ],
                [
                  "bottom-right",
                  anchorRight,
                  anchorBottom,
                ],
              ] as const) {
                await windows.setPosition({
                  x: outer.x,
                  y: outer.y,
                });
                assert.equal(
                  await windows.moveToAnchor({
                    anchor,
                    monitorId: centerTarget.id,
                    margin: 12,
                  }),
                  null,
                );
                assert.deepEqual(
                  {
                    ...(await windows.getOuterBounds()),
                  },
                  {
                    ...centered,
                    x,
                    y,
                  },
                );
              }
              assert.equal(await windows.isVisible(), false);
              assert.equal(
                user.symbols.GetForegroundWindow(),
                centerForeground,
              );
              await windows.setPosition({
                x: outer.x,
                y: outer.y,
              });
              await windows.moveToAnchor({
                anchor: "bottom-right",
              });
              assert.deepEqual(
                {
                  ...(await windows.getOuterBounds()),
                },
                {
                  ...centered,
                  x: anchorArea.x + anchorArea.width - centered.width,
                  y: anchorArea.y + anchorArea.height - centered.height,
                },
              );
              await windows.setPosition({
                x: outer.x,
                y: outer.y,
              });
              const movedBeforeAnchorReject = await windows.getOuterBounds();
              await assert.rejects(
                windows.moveToAnchor({
                  anchor: "top-left",
                  monitorId: "\\\\.\\DISPLAY999",
                }),
                {
                  code: "INVALID_ARGUMENT",
                },
              );
              assert.deepEqual(
                await windows.getOuterBounds(),
                movedBeforeAnchorReject,
              );
              await verifyMoveNextToRect({
                area: anchorArea,
                outer,
                centered,
                foreground: centerForeground,
              });
              await windows.setOuterBounds({
                x: outer.x,
                y: outer.y,
                width: outer.width,
                height: outer.height,
              });
              await windows.show();
              assert.deepEqual(await windows.getNormalBounds({}), outer);
              const inner = await windows.getContentBounds({});
              assert(inner.x >= outer.x && inner.y > outer.y);
              assert(outer.width > inner.width && outer.height > inner.height);
              assert.deepEqual(
                {
                  ...(await windows.getOuterSize({})),
                },
                {
                  width: outer.width,
                  height: outer.height,
                  dpi: outer.dpi,
                },
              );
              assert.deepEqual(
                {
                  ...(await windows.getContentPosition({})),
                },
                {
                  x: inner.x,
                  y: inner.y,
                  dpi: inner.dpi,
                },
              );
              const physical = await windows.toPhysical({
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
                width: 300,
                height: 300,
              });
              await assertContentSize(500, 400);
              await windows.setSize({
                width: 1000,
                height: 800,
              });
              await assertContentSize(800, 600);
              await windows.setSizeConstraints({
                minWidth: 600,
                maxWidth: 750,
                maxHeight: 550,
              });
              await assertContentSize(750, 550);
              await windows.setMinSize({
                width: 700,
                height: null,
              });
              assert.deepEqual(
                {
                  ...(await windows.getSizeConstraints()),
                },
                {
                  minWidth: 700,
                  minHeight: null,
                  maxWidth: 750,
                  maxHeight: 550,
                },
              );
              const beforeInvalid = await windows.getSizeConstraints();
              await assert.rejects(
                windows.setMaxSize({
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
                  ...(await windows.getSizeConstraints()),
                },
                {
                  ...beforeInvalid,
                },
              );
              await windows.setSizeConstraints({
                minHeight: 350,
              });
              assert.deepEqual(
                {
                  ...(await windows.getSizeConstraints()),
                },
                {
                  minWidth: null,
                  minHeight: 350,
                  maxWidth: null,
                  maxHeight: null,
                },
              );
              await windows.setMinSize({
                width: null,
                height: null,
              });
              await windows.setMaxSize({
                width: null,
                height: null,
              });
              assert.deepEqual(
                {
                  ...(await windows.getSizeConstraints()),
                },
                {
                  minWidth: null,
                  minHeight: null,
                  maxWidth: null,
                  maxHeight: null,
                },
              );
              await windows.setSize({
                width: 650,
                height: 550,
              });
              await windows.setSizeConstraints({
                minWidth: 600,
                minHeight: 500,
                maxWidth: 800,
                maxHeight: 700,
              });
              await windows.setFullscreen({
                fullscreen: true,
              });
              assert.equal(await windows.isFullscreen(), true);
              for (const name of [
                "minimize",
                "maximize",
                "unmaximize",
                "restore",
                "toggleMaximize",
                "center",
              ] as const) {
                await assert.rejects(windows[name](), {
                  code: "INVALID_ARGUMENT",
                });
              }
              await assert.rejects(
                windows.setSize({
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
                minWidth: 700,
                minHeight: 500,
                maxWidth: 800,
                maxHeight: 700,
              });
              assert.deepEqual(
                {
                  ...(await windows.getSizeConstraints()),
                },
                {
                  minWidth: 700,
                  minHeight: 500,
                  maxWidth: 800,
                  maxHeight: 700,
                },
              );
              await windows.setFullscreen({
                fullscreen: false,
              });
              await assertContentSize(700, 550);
              assert.equal(await windows.isFullscreen(), false);
              assert.equal(await windows.getOpacity(), 1);
              await windows.setOpacity({
                opacity: 0.5,
              });
              assert.ok(
                Math.abs((await windows.getOpacity()) - 0.5) <= 1 / 255,
              );
              await windows.setOpacity({
                opacity: 1,
              });
              assert.equal(await windows.getOpacity(), 1);
              // The declared color is live, and a runtime change replaces it.
              assert.equal(await windows.getBackgroundColor(), "#112233");
              await windows.setBackgroundColor({
                color: "#ABC",
              });
              assert.equal(await windows.getBackgroundColor(), "#aabbcc");
              await windows.setBackgroundColor({
                color: "#203040",
              });
              assert.equal(await windows.getBackgroundColor(), "#203040");
              await assert.rejects(
                windows.setBackgroundColor({
                  color: "#20304080",
                }),
                (error: unknown) =>
                  (
                    error as {
                      code: string;
                    }
                  ).code === "INVALID_ARGUMENT",
              );
              assert.equal(await windows.getBackgroundColor(), "#203040");
              assert.equal(await windows.isIgnoreMouseEvents(), false);
              await windows.setIgnoreMouseEvents({
                ignore: true,
              });
              assert.equal(await windows.isIgnoreMouseEvents(), true);
              await windows.setIgnoreMouseEvents({
                ignore: false,
              });
              assert.equal(await windows.isIgnoreMouseEvents(), false);
              assert.equal(await windows.isFullscreenable(), true);
              await windows.setFullscreenable({
                fullscreenable: false,
              });
              assert.equal(await windows.isFullscreenable(), false);
              await assert.rejects(
                windows.setFullscreen({
                  fullscreen: true,
                }),
                (error) =>
                  (
                    error as {
                      code?: string;
                    }
                  ).code === "INVALID_ARGUMENT",
              );
              assert.equal(await windows.isFullscreen(), false);
              // The state resets on recreate, which the next run asserts.
              console.log(
                JSON.stringify({
                  event: "window-api-geometry",
                }),
              );
              await windows.setCloseConfirmation({
                message: "Close window?",
              });
              await windows.setFocusable({
                focusable: true,
              });
              assert.equal(await windows.close(), false);
              assert.equal(await windows.isOpen(), true);
              // Recreation asks for the close confirmation again and revokes this document.
              await windows.recreate({});
              break;
            }
            default:
              await verifyRecreatedDeclaration(run);
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
      {
        view: "main",
        title: "Window API editor",
        home: "https://app.bunaway.local/index.html",
        window: {
          width: 300,
          height: 1000,
          minWidth: 500,
          minHeight: 400,
          maxWidth: 800,
          maxHeight: 600,
          backgroundColor: "#112233",
        },
      },
    ],
    assets,
    dataRoot: resolve(output, `data-${process.pid}`),
    loader: resolve(
      root,
      "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
    ),
  });
  process.exit(0);
}
