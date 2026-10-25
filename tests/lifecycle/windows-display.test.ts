import { expect, test } from "bun:test";
import { initialWindowStyles } from "#native/windows/bun/window-style";

test("custom creation retains resize and system-command flags while standard defaults remain unchanged", () => {
  expect(initialWindowStyles({})).toEqual({
    style: 0xcf0000n,
    exStyle: 0n,
  });
  expect(
    initialWindowStyles({
      titlebar: "custom",
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
    }),
  ).toEqual({
    style: 0xf0000n,
    exStyle: 0x08000088n,
  });
});

type PlacementReader = {
  isVisible(window: bigint): boolean;
  isMinimized(window: bigint): boolean;
  isMaximized(window: bigint): boolean;
  isFullscreen(window: bigint): boolean;
};

function placementOf(native: PlacementReader, window: bigint) {
  return {
    visible: native.isVisible(window),
    minimized: native.isMinimized(window),
    maximized: native.isMaximized(window),
    fullscreen: native.isFullscreen(window),
  };
}

/**
 * setSkipTaskbar requires a hidden normal window and reports a single BUSY error for any of
 * four states. Asserting them together names the state that was wrong when a run fails.
 * `history` names the states seen at earlier steps, so a failure shows where the placement drifted.
 */
function expectHiddenNormalPlacement(
  native: PlacementReader,
  window: bigint,
  history: Record<string, unknown> = {},
): void {
  expect(
    placementOf(native, window),
    `placement history: ${JSON.stringify(history)}`,
  ).toEqual({
    visible: false,
    minimized: false,
    maximized: false,
    fullscreen: false,
  });
}

test.skipIf(process.platform !== "win32")(
  "real custom caption, native resize hit testing, display flags and fullscreen restoration",
  async () => {
    const [{ Windows }, { user }, { dlopen }] = await Promise.all([
      import("#native/windows/bun/win32"),
      import("#native/windows/bun/win32-bindings"),
      import("bun:ffi"),
    ]);
    const messages = dlopen("user32.dll", {
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
    const native = new Windows(() => {});
    let hwnd = 0n;
    try {
      hwnd = native.create(
        "Accessible custom title",
        640,
        480,
        () => {},
        false,
        {
          titlebar: "custom",
          alwaysOnTop: true,
          skipTaskbar: true,
          x: 100,
          y: 100,
        },
      );
      expect(native.getTitlebar(hwnd)).toBe("custom");
      expect(native.getTitle(hwnd)).toBe("Accessible custom title");
      expect(native.isAlwaysOnTop(hwnd)).toBe(true);
      expect(native.isSkipTaskbar(hwnd)).toBe(true);
      expect(native.isVisible(hwnd)).toBe(false);
      expect(user.symbols.GetSystemMenu(hwnd, 0)).not.toBe(0n);
      const content = native.getBounds(hwnd, "content");
      const dpi = native.getDpi(hwnd);
      expect(content.width).toBe(Math.round((640 * dpi) / 96));
      expect(content.height).toBe(Math.round((480 * dpi) / 96));
      const outer = native.getBounds(hwnd, "outer");
      const point = BigInt(
        ((outer.x + 1) & 0xffff) |
          (((outer.y + Math.floor(outer.height / 2)) & 0xffff) << 16),
      );
      expect(messages.symbols.SendMessageW(hwnd, 0x84, 0n, point)).toBe(10n); // HTLEFT
      const foreground = user.symbols.GetForegroundWindow();
      native.setAlwaysOnTop(hwnd, false);
      expectHiddenNormalPlacement(native, hwnd);
      native.setSkipTaskbar(hwnd, false);
      expect(native.isAlwaysOnTop(hwnd)).toBe(false);
      expect(native.isSkipTaskbar(hwnd)).toBe(false);
      expect(native.getBounds(hwnd, "content")).toEqual(content);
      expect(user.symbols.GetForegroundWindow()).toBe(foreground);
      native.setResizable(hwnd, false);
      expect(native.isResizable(hwnd)).toBe(false);
      expect(native.getBounds(hwnd, "content").width).toBe(content.width);
      native.setResizable(hwnd, true);
      native.setFullscreen(hwnd, true);
      const fullscreenBounds = native.getBounds(hwnd, "outer");
      for (const command of [
        0xf000n,
        0xf010n,
        0xf020n,
        0xf030n,
        0xf120n,
      ]) {
        messages.symbols.SendMessageW(hwnd, 0x112, command, 0n);
        expect(native.isFullscreen(hwnd)).toBe(true);
        expect(native.isMinimized(hwnd)).toBe(false);
        expect(native.getBounds(hwnd, "outer")).toEqual(fullscreenBounds);
      }
      native.setAlwaysOnTop(hwnd, true);
      expect(native.getTitlebar(hwnd)).toBe("custom");
      expect(() => native.setSkipTaskbar(hwnd, true)).toThrow(
        "Hide and restore",
      );
      native.setFullscreen(hwnd, false);
      expect(native.isAlwaysOnTop(hwnd)).toBe(true);
      expect(native.getTitlebar(hwnd)).toBe("custom");
      expect(native.getBounds(hwnd, "content").width).toBe(content.width);
      native.maximize(hwnd);
      expect(native.isMaximized(hwnd)).toBe(true);
      expect(() => native.setSkipTaskbar(hwnd, true)).toThrow(
        "Hide and restore",
      );
      native.restore(hwnd);
      const restored = placementOf(native, hwnd);
      native.show(hwnd, false);
      expectHiddenNormalPlacement(native, hwnd, {
        restored,
      });
      native.setSkipTaskbar(hwnd, true);
      expect(native.isSkipTaskbar(hwnd)).toBe(true);
      native.showInactive(hwnd);
      expect(() => native.setSkipTaskbar(hwnd, false)).toThrow(
        "Hide and restore",
      );
    } finally {
      if (hwnd) {
        native.destroy(hwnd);
      }
      native.dispose();
      messages.close();
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "a display change refits a fullscreen window to its monitor and keeps the normal placement",
  async () => {
    const [{ Windows }, { user }, { dlopen }] = await Promise.all([
      import("#native/windows/bun/win32"),
      import("#native/windows/bun/win32-bindings"),
      import("bun:ffi"),
    ]);
    const messages = dlopen("user32.dll", {
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
    const WM_DISPLAYCHANGE = 0x7e;
    const SWP_NOZORDER_NOACTIVATE = 0x14;
    const native = new Windows(() => {});
    let hwnd = 0n;
    try {
      hwnd = native.create("Fullscreen refit", 640, 480, () => {}, false, {
        x: 100,
        y: 100,
      });
      const normal = native.getBounds(hwnd, "outer");
      native.setFullscreen(hwnd, true);
      const fullscreenBounds = native.getBounds(hwnd, "outer");

      // Windows only moves a window off a removed monitor and keeps its size.
      expect(
        user.symbols.SetWindowPos(
          hwnd,
          0n,
          fullscreenBounds.x + 40,
          fullscreenBounds.y + 30,
          fullscreenBounds.width - 200,
          fullscreenBounds.height - 100,
          SWP_NOZORDER_NOACTIVATE,
        ),
      ).not.toBe(0);
      expect(native.getBounds(hwnd, "outer")).not.toEqual(fullscreenBounds);

      messages.symbols.SendMessageW(hwnd, WM_DISPLAYCHANGE, 32n, 0n);
      expect(native.isFullscreen(hwnd)).toBe(true);
      expect(native.getBounds(hwnd, "outer")).toEqual(fullscreenBounds);

      // A change that leaves the window already fitted does nothing.
      messages.symbols.SendMessageW(hwnd, WM_DISPLAYCHANGE, 32n, 0n);
      expect(native.getBounds(hwnd, "outer")).toEqual(fullscreenBounds);

      // A change while minimized is applied when the window is restored.
      const SW_SHOWMINNOACTIVE = 7;
      const SW_SHOWNOACTIVATE = 4;
      const showWindow = dlopen("user32.dll", {
        ShowWindow: {
          args: [
            "u64",
            "i32",
          ],
          returns: "i32",
        },
      });
      try {
        user.symbols.SetWindowPos(
          hwnd,
          0n,
          fullscreenBounds.x + 40,
          fullscreenBounds.y + 30,
          fullscreenBounds.width - 200,
          fullscreenBounds.height - 100,
          SWP_NOZORDER_NOACTIVATE,
        );
        showWindow.symbols.ShowWindow(hwnd, SW_SHOWMINNOACTIVE);
        expect(user.symbols.IsIconic(hwnd)).not.toBe(0);
        messages.symbols.SendMessageW(hwnd, WM_DISPLAYCHANGE, 32n, 0n);
        showWindow.symbols.ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        expect(user.symbols.IsIconic(hwnd)).toBe(0);
        expect(native.getBounds(hwnd, "outer")).toEqual(fullscreenBounds);
      } finally {
        showWindow.close();
      }

      native.setFullscreen(hwnd, false);
      expect(native.getBounds(hwnd, "outer")).toEqual(normal);
    } finally {
      if (hwnd) {
        native.destroy(hwnd);
      }
      native.dispose();
      messages.close();
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "taskbar attention requests never activate or show the window and reject destroyed windows",
  async () => {
    const [{ Windows }, { user }] = await Promise.all([
      import("#native/windows/bun/win32"),
      import("#native/windows/bun/win32-bindings"),
    ]);
    const native = new Windows(() => {});
    let hwnd = 0n;
    try {
      hwnd = native.create("Attention", 640, 480, () => {}, false, {});
      native.showInactive(hwnd);
      const foreground = user.symbols.GetForegroundWindow();
      native.requestAttention(hwnd, "untilFocused");
      native.requestAttention(hwnd, "continuous");
      native.cancelAttention(hwnd);
      native.cancelAttention(hwnd);
      expect(native.isVisible(hwnd)).toBe(true);
      expect(user.symbols.GetForegroundWindow()).toBe(foreground);
      native.show(hwnd, false);
      native.requestAttention(hwnd, "continuous");
      native.cancelAttention(hwnd);
      expect(native.isVisible(hwnd)).toBe(false);
      native.destroy(hwnd);
      expect(() => native.requestAttention(hwnd, "untilFocused")).toThrow(
        "Window is no longer valid",
      );
      expect(() => native.cancelAttention(hwnd)).toThrow(
        "Window is no longer valid",
      );
      hwnd = 0n;
    } finally {
      if (hwnd) {
        native.destroy(hwnd);
      }
      native.dispose();
    }
  },
);

const HSHELL_FLASH = 0x8006n;
const PM_REMOVE = 1;
const ERROR_SUCCESS = 0;
const FLASHW_TRAY = 2;
const FLASHW_TIMER = 4;
const FLASHWINFO_SIZE = 32;
/** Upper bound for the shell to post the flash notification to the hook window. */
const SHELL_FLASH_DEADLINE_MS = 3000;
const SHELL_FLASH_POLL_INTERVAL_MS = 25;
const MSG_SIZE = 48;

test.skipIf(process.platform !== "win32")(
  "taskbar attention requests reach the shell and report invalid FLASHWINFO",
  async () => {
    const [{ Windows }, { user, kernel }, { withWide }, { dlopen, ptr }] =
      await Promise.all([
        import("#native/windows/bun/win32"),
        import("#native/windows/bun/win32-bindings"),
        import("@bunaway/plugin/win32"),
        import("bun:ffi"),
      ]);
    const shell = dlopen("user32.dll", {
      FindWindowW: {
        args: [
          "ptr",
          "ptr",
        ],
        returns: "u64",
      },
      RegisterShellHookWindow: {
        args: [
          "u64",
        ],
        returns: "i32",
      },
      DeregisterShellHookWindow: {
        args: [
          "u64",
        ],
        returns: "i32",
      },
    });
    const native = new Windows(() => {});
    let hwnd = 0n;
    let receiver = 0n;
    let hooked = false;
    try {
      hwnd = native.create("Attention target", 640, 480, () => {}, false, {});
      native.showInactive(hwnd);

      // Negative control: FlashWindowEx returns the previous caption state, so the
      // last error is the only failure signal. A zero cbSize must set it, which
      // proves the check used by Windows.requestAttention works on this runner.
      const invalid = Buffer.alloc(FLASHWINFO_SIZE);
      invalid.writeBigUInt64LE(hwnd, 8);
      invalid.writeUInt32LE(FLASHW_TRAY | FLASHW_TIMER, 16);
      kernel.symbols.SetLastError(ERROR_SUCCESS);
      expect(user.symbols.FlashWindowEx(ptr(invalid))).toBe(0);
      // ERROR_INVALID_PARAMETER (87) is expected; any nonzero code proves the oracle.
      expect(kernel.symbols.GetLastError()).not.toBe(ERROR_SUCCESS);

      // The shell posts SHELLHOOK/HSHELL_FLASH (lParam = flashing hwnd) to windows
      // registered with RegisterShellHookWindow. A second hidden window on this
      // thread receives it, and PeekMessageW pulls it from the queue without a wndproc.
      const hasTaskbarShell =
        withWide("Shell_TrayWnd", (name) =>
          shell.symbols.FindWindowW(name, null),
        ) !== 0n;
      const shellHookMessage = withWide("SHELLHOOK", (name) =>
        user.symbols.RegisterWindowMessageW(name),
      );
      expect(shellHookMessage).not.toBe(0);
      receiver = native.create(
        "Attention receiver",
        320,
        240,
        () => {},
        false,
        {},
      );
      hooked = shell.symbols.RegisterShellHookWindow(receiver) !== 0;
      expect(hooked).toBe(true);

      native.requestAttention(hwnd, "continuous");
      const message = Buffer.alloc(MSG_SIZE);
      let flashObserved = false;
      const deadline = Date.now() + SHELL_FLASH_DEADLINE_MS;
      while (!flashObserved && Date.now() < deadline) {
        while (
          user.symbols.PeekMessageW(
            ptr(message),
            receiver,
            shellHookMessage,
            shellHookMessage,
            PM_REMOVE,
          ) !== 0
        ) {
          // MSG layout on x64: message u32 at 8, wParam at 16, lParam at 24.
          if (
            message.readBigUInt64LE(16) === HSHELL_FLASH &&
            message.readBigUInt64LE(24) === hwnd
          ) {
            flashObserved = true;
          }
        }
        if (!flashObserved) {
          await Bun.sleep(SHELL_FLASH_POLL_INTERVAL_MS);
        }
      }
      native.cancelAttention(hwnd);
      if (hasTaskbarShell) {
        expect(flashObserved).toBe(true);
      } else {
        // Without Explorer's taskbar the runner may never deliver shell-hook flash
        // notifications, so only the strict last-error checks above apply.
        console.log(
          `UNTESTED HSHELL_FLASH delivery: no Shell_TrayWnd (observed=${flashObserved}).`,
        );
      }
    } finally {
      if (hooked) {
        shell.symbols.DeregisterShellHookWindow(receiver);
      }
      if (receiver) {
        native.destroy(receiver);
      }
      if (hwnd) {
        native.destroy(hwnd);
      }
      native.dispose();
      shell.close();
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "tool-window caption changes preserve constrained system-caption content",
  async () => {
    const { Windows } = await import("#native/windows/bun/win32");
    const native = new Windows(() => {});
    let hwnd = 0n;
    try {
      hwnd = native.create("System caption", 640, 480, () => {}, false, {
        minHeight: 480,
        maxHeight: 480,
      });
      const before = native.getBounds(hwnd, "content");
      for (const skipTaskbar of [
        true,
        false,
        true,
        false,
      ]) {
        native.setSkipTaskbar(hwnd, skipTaskbar);
        const after = native.getBounds(hwnd, "content");
        expect(after.width).toBe(before.width);
        expect(after.height).toBe(before.height);
        expect(native.isVisible(hwnd)).toBe(false);
      }
    } finally {
      if (hwnd) {
        native.destroy(hwnd);
      }
      native.dispose();
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "content protection applies at creation and round-trips through the OS display affinity",
  async () => {
    const [{ Windows }, { dlopen, ptr }] = await Promise.all([
      import("#native/windows/bun/win32"),
      import("bun:ffi"),
    ]);
    // Read the affinity through an independent binding so the test does not rely on the code under test.
    const affinityApi = dlopen("user32.dll", {
      GetWindowDisplayAffinity: {
        args: [
          "u64",
          "ptr",
        ],
        returns: "i32",
      },
    });
    const WDA_NONE = 0x0;
    const WDA_MONITOR = 0x1;
    const WDA_EXCLUDEFROMCAPTURE = 0x11;
    const rawAffinity = (window: bigint) => {
      const out = Buffer.alloc(4);
      expect(
        affinityApi.symbols.GetWindowDisplayAffinity(window, ptr(out)),
      ).not.toBe(0);
      return out.readUInt32LE(0);
    };
    const native = new Windows(() => {});
    let hwnd = 0n;
    try {
      hwnd = native.create("Protected", 640, 480, () => {}, false, {
        contentProtection: true,
      });
      expect([
        WDA_MONITOR,
        WDA_EXCLUDEFROMCAPTURE,
      ]).toContain(rawAffinity(hwnd));
      expect(native.isContentProtected(hwnd)).toBe(true);
      native.setContentProtection(hwnd, false);
      expect(rawAffinity(hwnd)).toBe(WDA_NONE);
      expect(native.isContentProtected(hwnd)).toBe(false);
      native.setContentProtection(hwnd, true);
      expect(rawAffinity(hwnd)).not.toBe(WDA_NONE);
      expect(native.isContentProtected(hwnd)).toBe(true);
    } finally {
      if (hwnd) {
        native.destroy(hwnd);
      }
      native.dispose();
      affinityApi.close();
    }
  },
);
