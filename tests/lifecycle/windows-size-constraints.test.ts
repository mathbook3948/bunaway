import { test } from "bun:test";
import assert from "node:assert/strict";

const WM_GETMINMAXINFO = 0x0024;
const WM_DPICHANGED = 0x02e0;
const WM_ACTIVATE = 0x0006;
const WM_SHOWWINDOW = 0x0018;
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WINDOWPLACEMENT_SIZE = 44;
const WINDOWPLACEMENT_NORMAL_RECT_OFFSET = 28;
const SW_MINIMIZE = 6;
const SW_HIDE = 0;
const SW_SHOW = 5;
const SW_MAXIMIZE = 3;
const SW_RESTORE = 9;
const DEFAULT_DPI = 96;
const MONITORINFO_SIZE = 40;
const MONITOR_DEFAULTTONEAREST = 2;

function physicalPixels(logicalPixels: number, dpi: number) {
  return Math.round((logicalPixels * dpi) / DEFAULT_DPI);
}

function logicalPixels(physicalPixels: number, dpi: number) {
  return Math.round((physicalPixels * DEFAULT_DPI) / dpi);
}

test.skipIf(process.platform !== "win32")(
  "Windows native callbacks preserve logical size constraints across DPI and fullscreen changes",
  async () => {
    const [{ Windows }, { user, withBuffer }, { dlopen }] = await Promise.all([
      import("../../native/windows/bun/win32.ts"),
      import("../../native/windows/bun/win32-bindings.ts"),
      import("bun:ffi"),
    ]);
    const messaging = dlopen("user32.dll", {
      SendMessageW: {
        args: [
          "u64",
          "u32",
          "u64",
          "ptr",
        ],
        returns: "i64",
      },
      GetActiveWindow: {
        args: [],
        returns: "u64",
      },
      SetActiveWindow: {
        args: [
          "u64",
        ],
        returns: "u64",
      },
      GetForegroundWindow: {
        args: [],
        returns: "u64",
      },
      GetFocus: {
        args: [],
        returns: "u64",
      },
      SetFocus: {
        args: [
          "u64",
        ],
        returns: "u64",
      },
    });
    let windows: InstanceType<typeof Windows> | undefined;
    let window = 0n;
    let inputWindow = 0n;
    let targetActivations = 0;
    let targetShows = 0;
    let failure: unknown;

    const clientPhysicalSize = (hwnd: bigint) => {
      const rect = Buffer.alloc(16);
      assert(
        withBuffer(rect, (pointer) =>
          user.symbols.GetClientRect(hwnd, pointer),
        ),
      );
      return {
        width: rect.readInt32LE(8) - rect.readInt32LE(0),
        height: rect.readInt32LE(12) - rect.readInt32LE(4),
      };
    };

    const windowStyle = (hwnd: bigint) =>
      user.symbols.GetWindowLongPtrW(hwnd, GWL_STYLE);
    const extendedWindowStyle = (hwnd: bigint) =>
      user.symbols.GetWindowLongPtrW(hwnd, GWL_EXSTYLE);

    const windowPhysicalSize = (hwnd: bigint) => {
      const rect = Buffer.alloc(16);
      assert(
        withBuffer(rect, (pointer) =>
          user.symbols.GetWindowRect(hwnd, pointer),
        ),
      );
      return {
        width: rect.readInt32LE(8) - rect.readInt32LE(0),
        height: rect.readInt32LE(12) - rect.readInt32LE(4),
      };
    };

    const outerSizeFor = (
      width: number,
      height: number,
      dpi: number,
      style: bigint,
      exStyle: bigint,
    ) => {
      const rect = Buffer.alloc(16);
      rect.writeInt32LE(physicalPixels(width, dpi), 8);
      rect.writeInt32LE(physicalPixels(height, dpi), 12);
      assert(
        withBuffer(rect, (pointer) =>
          user.symbols.AdjustWindowRectExForDpi(
            pointer,
            Number(style),
            0,
            Number(exStyle),
            dpi,
          ),
        ),
      );
      return {
        width: rect.readInt32LE(8) - rect.readInt32LE(0),
        height: rect.readInt32LE(12) - rect.readInt32LE(4),
      };
    };

    const sendMinMaxInfo = (hwnd: bigint) => {
      const info = Buffer.alloc(40);
      // Windows initializes these before dispatching a real sizing message.
      // Seed primary-monitor defaults for the synthetic callback regression.
      info.writeInt32LE(1920, 8);
      info.writeInt32LE(1080, 12);
      info.writeInt32LE(-8, 16);
      info.writeInt32LE(-8, 20);
      info.writeInt32LE(200, 24);
      info.writeInt32LE(100, 28);
      info.writeInt32LE(8192, 32);
      info.writeInt32LE(8192, 36);
      withBuffer(info, (pointer) =>
        messaging.symbols.SendMessageW(hwnd, WM_GETMINMAXINFO, 0n, pointer),
      );
      return info;
    };

    const sendDpiChanged = (hwnd: bigint, dpi: number) => {
      const size = outerSizeFor(
        600,
        450,
        dpi,
        windowStyle(hwnd),
        extendedWindowStyle(hwnd),
      );
      const suggested = Buffer.alloc(16);
      suggested.writeInt32LE(32, 0);
      suggested.writeInt32LE(32, 4);
      suggested.writeInt32LE(32 + size.width, 8);
      suggested.writeInt32LE(32 + size.height, 12);
      withBuffer(suggested, (pointer) =>
        messaging.symbols.SendMessageW(
          hwnd,
          WM_DPICHANGED,
          BigInt(dpi),
          pointer,
        ),
      );
      assert.equal(windows?.failure, undefined);
    };

    const assertFullscreenMonitorBounds = (hwnd: bigint) => {
      const monitor = Buffer.alloc(MONITORINFO_SIZE);
      monitor.writeUInt32LE(MONITORINFO_SIZE);
      assert(
        withBuffer(monitor, (pointer) =>
          user.symbols.GetMonitorInfoW(
            user.symbols.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST),
            pointer,
          ),
        ),
      );
      const rect = Buffer.alloc(16);
      assert(
        withBuffer(rect, (pointer) =>
          user.symbols.GetWindowRect(hwnd, pointer),
        ),
      );
      assert.deepEqual(rect, monitor.subarray(4, 20));
      assert.deepEqual(clientPhysicalSize(hwnd), {
        width: monitor.readInt32LE(12) - monitor.readInt32LE(4),
        height: monitor.readInt32LE(16) - monitor.readInt32LE(8),
      });
      assert(windows?.isFullscreen(hwnd));
    };

    const assertLogicalClientSize = (
      hwnd: bigint,
      dpi: number,
      width: number,
      height: number,
    ) => {
      const size = clientPhysicalSize(hwnd);
      assert.deepEqual(
        {
          width: logicalPixels(size.width, dpi),
          height: logicalPixels(size.height, dpi),
        },
        {
          width,
          height,
        },
        JSON.stringify({
          dpi,
          physical: size,
          width,
          height,
        }),
      );
    };

    const assertPlacementLogicalSize = (
      hwnd: bigint,
      dpi: number,
      width: number,
      height: number,
      style = windowStyle(hwnd),
    ) => {
      const placement = Buffer.alloc(WINDOWPLACEMENT_SIZE);
      placement.writeUInt32LE(WINDOWPLACEMENT_SIZE);
      assert(
        withBuffer(placement, (pointer) =>
          user.symbols.GetWindowPlacement(hwnd, pointer),
        ),
      );
      const offset = WINDOWPLACEMENT_NORMAL_RECT_OFFSET;
      const outerWidth =
        placement.readInt32LE(offset + 8) - placement.readInt32LE(offset);
      const outerHeight =
        placement.readInt32LE(offset + 12) - placement.readInt32LE(offset + 4);
      const frame = outerSizeFor(0, 0, dpi, style, extendedWindowStyle(hwnd));
      assert.deepEqual(
        {
          width: logicalPixels(outerWidth - frame.width, dpi),
          height: logicalPixels(outerHeight - frame.height, dpi),
        },
        {
          width,
          height,
        },
      );
    };

    try {
      windows = new Windows(() => {});
      window = windows.create(
        "Size constraints callback test",
        800,
        600,
        (message, wparam) => {
          if (message === WM_ACTIVATE && (wparam & 0xffffn) !== 0n) {
            targetActivations++;
          }
          if (message === WM_SHOWWINDOW && wparam !== 0n) {
            targetShows++;
          }
        },
        false,
      );
      const originalStyle = windowStyle(window);
      const originalExStyle = extendedWindowStyle(window);
      const originalDpi = user.symbols.GetDpiForWindow(window);
      assert(originalDpi);

      const defaults = sendMinMaxInfo(window);
      const defaultTracks = {
        minWidth: defaults.readInt32LE(24),
        minHeight: defaults.readInt32LE(28),
        maxWidth: defaults.readInt32LE(32),
        maxHeight: defaults.readInt32LE(36),
      };
      windows.setSizeConstraints(window, {
        minWidth: 420,
        minHeight: null,
        maxWidth: null,
        maxHeight: 720,
      });
      const constrained = sendMinMaxInfo(window);
      assert.deepEqual(constrained.subarray(8, 24), defaults.subarray(8, 24));
      const minOuter = outerSizeFor(
        420,
        0,
        originalDpi,
        originalStyle,
        originalExStyle,
      );
      const maxOuter = outerSizeFor(
        0,
        720,
        originalDpi,
        originalStyle,
        originalExStyle,
      );
      assert.equal(
        constrained.readInt32LE(24),
        Math.max(defaultTracks.minWidth, minOuter.width),
      );
      assert.equal(constrained.readInt32LE(28), defaultTracks.minHeight);
      assert.equal(constrained.readInt32LE(32), defaultTracks.maxWidth);
      assert.equal(
        constrained.readInt32LE(36),
        Math.min(defaultTracks.maxHeight, maxOuter.height),
      );
      windows.setSizeConstraints(window, {
        minWidth: null,
        minHeight: null,
        maxWidth: null,
        maxHeight: null,
      });
      assert.deepEqual(sendMinMaxInfo(window), defaults);

      windows.setSizeConstraints(window, {
        minWidth: 500,
        minHeight: 400,
        maxWidth: 800,
        maxHeight: 600,
      });
      windows.setSize(window, 100, 100);
      assertLogicalClientSize(window, originalDpi, 500, 400);
      windows.setSizeConstraints(window, {
        minWidth: 600,
        minHeight: 500,
        maxWidth: 650,
        maxHeight: 550,
      });
      assertLogicalClientSize(window, originalDpi, 600, 500);
      assert.throws(() =>
        windows?.setSizeConstraints(window, {
          minWidth: 700,
          minHeight: 500,
          maxWidth: 650,
          maxHeight: 550,
        }),
      );
      assert.deepEqual(windows.getSizeConstraints(window), {
        minWidth: 600,
        minHeight: 500,
        maxWidth: 650,
        maxHeight: 550,
      });

      windows.setSizeConstraints(window, {
        minWidth: 500,
        minHeight: 400,
        maxWidth: 800,
        maxHeight: 600,
      });
      windows.setSize(window, 600, 450);
      const doubleDpi = originalDpi * 2;
      sendDpiChanged(window, doubleDpi);
      const doubledMinMax = sendMinMaxInfo(window);
      const doubledMin = outerSizeFor(
        500,
        400,
        doubleDpi,
        originalStyle,
        originalExStyle,
      );
      const doubledMax = outerSizeFor(
        800,
        600,
        doubleDpi,
        originalStyle,
        originalExStyle,
      );
      assert(doubledMinMax.readInt32LE(24) >= doubledMin.width);
      assert(doubledMinMax.readInt32LE(28) >= doubledMin.height);
      assert(doubledMinMax.readInt32LE(32) <= doubledMax.width);
      assert(doubledMinMax.readInt32LE(36) <= doubledMax.height);
      assert.deepEqual(windows.getSizeConstraints(window), {
        minWidth: 500,
        minHeight: 400,
        maxWidth: 800,
        maxHeight: 600,
      });
      sendDpiChanged(window, originalDpi);
      assertLogicalClientSize(window, originalDpi, 600, 450);

      user.symbols.ShowWindow(window, SW_MINIMIZE);
      assert(user.symbols.IsIconic(window));
      sendDpiChanged(window, doubleDpi);
      assertPlacementLogicalSize(window, doubleDpi, 600, 450);
      sendDpiChanged(window, originalDpi);
      assertPlacementLogicalSize(window, originalDpi, 600, 450);
      user.symbols.ShowWindow(window, SW_RESTORE);

      user.symbols.ShowWindow(window, SW_MAXIMIZE);
      assert(user.symbols.IsZoomed(window));
      sendDpiChanged(window, doubleDpi);
      assertPlacementLogicalSize(window, doubleDpi, 600, 450);
      sendDpiChanged(window, originalDpi);
      assertPlacementLogicalSize(window, originalDpi, 600, 450);
      user.symbols.ShowWindow(window, SW_RESTORE);

      windows.setSizeConstraints(window, {
        minWidth: null,
        minHeight: null,
        maxWidth: null,
        maxHeight: null,
      });
      user.symbols.ShowWindow(window, SW_MAXIMIZE);
      assert(user.symbols.IsZoomed(window));
      const maximizedPhysicalSize = windowPhysicalSize(window);
      for (const visible of [
        false,
        true,
      ]) {
        user.symbols.ShowWindow(window, visible ? SW_SHOW : SW_HIDE);
        for (const dpi of [
          doubleDpi,
          originalDpi,
        ]) {
          sendDpiChanged(window, dpi);
          assert(user.symbols.IsZoomed(window));
          assert.equal(user.symbols.IsWindowVisible(window) !== 0, visible);
          // A synthetic DPI change keeps the physical monitor unchanged.
          // The suggested 600x450 rect must not become the maximized size.
          assert.deepEqual(windowPhysicalSize(window), maximizedPhysicalSize);
          assertPlacementLogicalSize(window, dpi, 600, 450);
        }
      }
      user.symbols.ShowWindow(window, SW_RESTORE);
      assertLogicalClientSize(window, originalDpi, 600, 450);
      windows.setSizeConstraints(window, {
        minWidth: 500,
        minHeight: 400,
        maxWidth: 800,
        maxHeight: 600,
      });

      const fullscreenStyle = windowStyle(window);
      windows.setFullscreen(window, true);
      assert.notEqual(windowStyle(window), fullscreenStyle);
      windows.setSizeConstraints(window, {
        minWidth: 620,
        minHeight: 480,
        maxWidth: 700,
        maxHeight: 540,
      });
      windows.setSize(window, 600, 450);
      windows.setFullscreen(window, false);
      assert.equal(windowStyle(window), fullscreenStyle);
      assertLogicalClientSize(window, originalDpi, 620, 480);
      const restoredMinMax = sendMinMaxInfo(window);
      const restoredMin = outerSizeFor(
        620,
        480,
        originalDpi,
        fullscreenStyle,
        originalExStyle,
      );
      assert(restoredMinMax.readInt32LE(24) >= restoredMin.width);
      assert(restoredMinMax.readInt32LE(28) >= restoredMin.height);

      windows.setSizeConstraints(window, {
        minWidth: null,
        minHeight: null,
        maxWidth: null,
        maxHeight: null,
      });
      user.symbols.ShowWindow(window, SW_MAXIMIZE);
      assert(user.symbols.IsZoomed(window));
      const unconstrainedMaximizedSize = clientPhysicalSize(window);
      inputWindow = windows.create("Input focus test", 400, 300, () => {});
      const keepInputFocus = (change: () => void) => {
        messaging.symbols.SetActiveWindow(inputWindow);
        messaging.symbols.SetFocus(inputWindow);
        assert.equal(messaging.symbols.GetActiveWindow(), inputWindow);
        assert.equal(messaging.symbols.GetFocus(), inputWindow);
        const foreground = messaging.symbols.GetForegroundWindow();
        targetActivations = 0;
        change();
        assert.equal(targetActivations, 0, "Background window was activated.");
        assert.equal(messaging.symbols.GetActiveWindow(), inputWindow);
        assert.equal(messaging.symbols.GetFocus(), inputWindow);
        assert.equal(messaging.symbols.GetForegroundWindow(), foreground);
        assert.equal(windows?.failure, undefined);
      };
      for (const size of [
        {
          width: 640,
          height: 500,
        },
        {
          width: 700,
          height: 540,
        },
      ]) {
        keepInputFocus(() => {
          windows?.setSizeConstraints(window, {
            minWidth: size.width,
            minHeight: size.height,
            maxWidth: size.width,
            maxHeight: size.height,
          });
        });
        assert(user.symbols.IsZoomed(window));
        assertLogicalClientSize(window, originalDpi, size.width, size.height);
        assertPlacementLogicalSize(
          window,
          originalDpi,
          size.width,
          size.height,
        );
      }
      keepInputFocus(() => {
        windows?.setSizeConstraints(window, {
          minWidth: null,
          minHeight: null,
          maxWidth: null,
          maxHeight: null,
        });
        windows?.setSize(window, 600, 450);
        sendDpiChanged(window, doubleDpi);
        sendDpiChanged(window, originalDpi);
      });
      assert(user.symbols.IsZoomed(window));
      assert.deepEqual(clientPhysicalSize(window), unconstrainedMaximizedSize);
      assertPlacementLogicalSize(window, originalDpi, 600, 450);
      user.symbols.ShowWindow(window, SW_HIDE);
      keepInputFocus(() => {
        windows?.setSizeConstraints(window, {
          minWidth: 600,
          minHeight: 450,
          maxWidth: 600,
          maxHeight: 450,
        });
        sendDpiChanged(window, doubleDpi);
        sendDpiChanged(window, originalDpi);
      });
      assert(user.symbols.IsZoomed(window));
      assert.equal(user.symbols.IsWindowVisible(window), 0);
      assertLogicalClientSize(window, originalDpi, 600, 450);
      user.symbols.ShowWindow(window, SW_RESTORE);
      assertLogicalClientSize(window, originalDpi, 600, 450);

      user.symbols.ShowWindow(window, SW_MINIMIZE);
      windows.setSizeConstraints(window, {
        minWidth: 620,
        minHeight: 480,
        maxWidth: 620,
        maxHeight: 480,
      });
      assert(user.symbols.IsIconic(window));
      assertPlacementLogicalSize(window, originalDpi, 620, 480);
      user.symbols.ShowWindow(window, SW_RESTORE);
      assertLogicalClientSize(window, originalDpi, 620, 480);

      windows.setSizeConstraints(window, {
        minWidth: 500,
        minHeight: 400,
        maxWidth: 800,
        maxHeight: 600,
      });
      windows.setSize(window, 600, 450);
      windows.setFullscreen(window, true);
      for (const visible of [
        false,
        true,
      ]) {
        user.symbols.ShowWindow(window, visible ? SW_SHOW : SW_HIDE);
        for (const dpi of [
          doubleDpi,
          originalDpi,
        ]) {
          sendDpiChanged(window, dpi);
          assertFullscreenMonitorBounds(window);
          assert.equal(user.symbols.IsWindowVisible(window) !== 0, visible);
          assert.deepEqual(windows.getSizeConstraints(window), {
            minWidth: 500,
            minHeight: 400,
            maxWidth: 800,
            maxHeight: 600,
          });
        }
      }
      windows.setSizeConstraints(window, {
        minWidth: 620,
        minHeight: 480,
        maxWidth: 700,
        maxHeight: 540,
      });
      windows.setFullscreen(window, false);
      assert.equal(windowStyle(window), fullscreenStyle);
      assertLogicalClientSize(window, originalDpi, 620, 480);
      assert(user.symbols.IsWindowVisible(window));

      for (const showState of [
        SW_RESTORE,
        SW_MINIMIZE,
        SW_MAXIMIZE,
      ]) {
        user.symbols.ShowWindow(window, showState);
        user.symbols.ShowWindow(window, SW_HIDE);
        const minimized = user.symbols.IsIconic(window);
        const maximized = user.symbols.IsZoomed(window);
        targetShows = 0;
        keepInputFocus(() => {
          windows?.setSizeConstraints(window, {
            minWidth: 650,
            minHeight: 500,
            maxWidth: 650,
            maxHeight: 500,
          });
          sendDpiChanged(window, doubleDpi);
          sendDpiChanged(window, originalDpi);
          windows?.setFullscreen(window, true);
          windows?.setFullscreen(window, false);
        });
        assert.equal(targetShows, 0, "Hidden window was briefly shown.");
        assert.equal(user.symbols.IsWindowVisible(window), 0);
        assert.equal(user.symbols.IsIconic(window), minimized);
        assert.equal(user.symbols.IsZoomed(window), maximized);
        assertPlacementLogicalSize(window, originalDpi, 650, 500);
        user.symbols.ShowWindow(window, SW_RESTORE);
        assertLogicalClientSize(window, originalDpi, 650, 500);
      }
    } catch (error) {
      failure = error;
    }

    const cleanupErrors: unknown[] = [];
    if (inputWindow && windows) {
      try {
        windows.destroy(inputWindow);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (window && windows) {
      try {
        windows.destroy(window);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (windows) {
      try {
        windows.dispose();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    messaging.close();
    if (failure && cleanupErrors.length) {
      throw new AggregateError([
        failure,
        ...cleanupErrors,
      ]);
    }
    if (failure) {
      throw failure;
    }
    if (cleanupErrors.length) {
      throw new AggregateError(cleanupErrors, "Native test cleanup failed.");
    }
  },
  30_000,
);
