import { linkSymbols, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { hostResponse } from "#native/windows/bun/host-response";

// Isolate the DLL substitute from the real Windows callback tests.
const WM_DPICHANGED = 0x02e0;
const WM_WINDOWPOSCHANGED = 0x0047;
const WM_DISPLAYCHANGE = 0x007e;
const WS_OVERLAPPEDWINDOW = 0x00cf0000;
const WS_VISIBLE = 0x10000000n;
const GWL_STYLE = -16;
const SW_HIDE = 0;
const SW_SHOWNORMAL = 1;
const SW_SHOWMAXIMIZED = 3;
const SW_SHOWMINIMIZED = 2;
const SWP_NOSIZE = 0x1;
const WPF_RESTORETOMAXIMIZED = 0x2;
const SWP_NOMOVE = 0x2;
const SWP_NOACTIVATE = 0x10;
const FRAME_WIDTH = 16;
const FRAME_HEIGHT = 39;
const monitors = [
  {
    handle: 1n,
    left: 0,
    top: 0,
    right: 1920,
    bottom: 1080,
    dpi: 96,
  },
  {
    handle: 2n,
    left: -2560,
    top: 0,
    right: 0,
    bottom: 1440,
    dpi: 144,
  },
];
const windowRect = {
  left: -300,
  top: 100,
  right: 316,
  bottom: 589,
};
const normalRect = {
  ...windowRect,
};
const removedMonitors = new Set<bigint>();
let maximized = false;
let minimized = false;
let style = BigInt(WS_OVERLAPPEDWINDOW);
let callbackAddress = 0;
let positionFlags = 0;

function view(address: Pointer, size: number) {
  return new DataView(toArrayBuffer(address, 0, size));
}

/** Selects the simulated monitor with the largest overlap with a window rectangle. */
function monitorFor(rect: typeof windowRect) {
  let largestArea = -1;
  let selected = -1;
  for (const [index, monitor] of monitors.entries()) {
    if (removedMonitors.has(monitor.handle)) {
      continue;
    }
    const width = Math.max(
      0,
      Math.min(rect.right, monitor.right) - Math.max(rect.left, monitor.left),
    );
    const height = Math.max(
      0,
      Math.min(rect.bottom, monitor.bottom) - Math.max(rect.top, monitor.top),
    );
    if (width * height > largestArea) {
      largestArea = width * height;
      selected = index;
    }
  }
  return monitors[selected]?.handle ?? 0n;
}

function monitorInfo(handle: bigint) {
  const monitor = monitors.find((monitor) => monitor.handle === handle);
  assert(monitor, "Expected a configured monitor handle.");
  return monitor;
}

const wide = (text: string) => Buffer.from(`${text}\0`, "utf16le");
mock.module(import.meta.resolve("#native/windows/bun/win32-bindings"), () => ({
  hr: (result: number) => assert(result >= 0),
  wide,
  withWide: <T>(text: string, action: (address: Pointer) => T) =>
    action(ptr(wide(text))),
  kernel: {
    symbols: {
      GetCurrentThreadId: () => 1,
      GetModuleHandleW: () => 1n,
      GetLastError: () => 0,
      SetLastError() {},
    },
  },
  user: {
    symbols: {
      LoadIconW: () => 1n,
      SetThreadDpiAwarenessContext: () => -4n,
      RegisterClassExW(address: Pointer) {
        callbackAddress = Number(view(address, 80).getBigUint64(8, true));
        return 1;
      },
      UnregisterClassW: () => 1,
      CreateWindowExW: () => 1n,
      DestroyWindow: () => 1,
      IsWindow: () => 1,
      IsWindowVisible: () => Number((style & WS_VISIBLE) !== 0n),
      IsIconic: () => Number(minimized),
      IsZoomed: () => Number(maximized),
      DefWindowProcW: () => 0n,
      ShowWindow(_window: bigint, command: number) {
        style = command === SW_HIDE ? style & ~WS_VISIBLE : style | WS_VISIBLE;
        return 1;
      },
      GetDpiForWindow: () => monitorInfo(monitorFor(windowRect)).dpi,
      GetWindowLongPtrW: (_window: bigint, index: number) =>
        index === GWL_STYLE ? style : 0n,
      SetWindowLongPtrW(_window: bigint, _index: number, next: bigint) {
        const previous = style;
        style = next;
        return previous;
      },
      AdjustWindowRectExForDpi(address: Pointer, requestedStyle: number) {
        const rect = view(address, 16);
        if (requestedStyle & WS_OVERLAPPEDWINDOW) {
          rect.setInt32(8, rect.getInt32(8, true) + FRAME_WIDTH, true);
          rect.setInt32(12, rect.getInt32(12, true) + FRAME_HEIGHT, true);
        }
        return 1;
      },
      GetWindowPlacement(_window: bigint, address: Pointer) {
        const placement = view(address, 44);
        // Windows can retain maximize history after returning to a normal window.
        placement.setUint32(4, WPF_RESTORETOMAXIMIZED, true);
        let showCommand = SW_SHOWNORMAL;
        if (minimized) {
          showCommand = SW_SHOWMINIMIZED;
        } else if (maximized) {
          showCommand = SW_SHOWMAXIMIZED;
        }
        placement.setUint32(8, showCommand, true);
        const restored = maximized || minimized ? normalRect : windowRect;
        const primary = monitorFor(restored) === monitors[0]?.handle;
        [
          restored.left - (primary ? 24 : 0),
          restored.top - (primary ? 40 : 0),
          restored.right - (primary ? 24 : 0),
          restored.bottom - (primary ? 40 : 0),
        ].forEach((value, index) => {
          placement.setInt32(28 + index * 4, value, true);
        });
        return 1;
      },
      SetWindowPlacement(_window: bigint, address: Pointer) {
        const placement = view(address, 44);
        assert.equal(
          placement.getUint32(4, true) & WPF_RESTORETOMAXIMIZED,
          minimized ? WPF_RESTORETOMAXIMIZED : 0,
        );
        assert.equal(placement.getUint32(8, true), SW_HIDE);
        // WINDOWPLACEMENT uses workspace coordinates; the mock HWND uses screen coordinates.
        const primary = monitorFor(normalRect) === monitors[0]?.handle;
        windowRect.left = placement.getInt32(28, true) + (primary ? 24 : 0);
        windowRect.top = placement.getInt32(32, true) + (primary ? 40 : 0);
        windowRect.right = placement.getInt32(36, true) + (primary ? 24 : 0);
        windowRect.bottom = placement.getInt32(40, true) + (primary ? 40 : 0);
        Object.assign(normalRect, windowRect);
        return 1;
      },
      MonitorFromWindow: () => monitorFor(windowRect),
      MonitorFromRect(address: Pointer) {
        const rect = view(address, 16);
        return monitorFor({
          left: rect.getInt32(0, true),
          top: rect.getInt32(4, true),
          right: rect.getInt32(8, true),
          bottom: rect.getInt32(12, true),
        });
      },
      GetMonitorInfoW(monitor: bigint, address: Pointer) {
        const bounds = monitors.find((display) => display.handle === monitor);
        if (!bounds || removedMonitors.has(monitor)) {
          return 0;
        }
        const info = view(address, 40);
        [
          bounds.left,
          bounds.top,
          bounds.right,
          bounds.bottom,
        ].forEach((value, index) => {
          info.setInt32(4 + index * 4, value, true);
        });
        [
          bounds.left + (bounds === monitors[0] ? 24 : 0),
          bounds.top + (bounds === monitors[0] ? 40 : 0),
          bounds.right,
          bounds.bottom,
        ].forEach((value, index) => {
          info.setInt32(20 + index * 4, value, true);
        });
        return 1;
      },
      GetWindowRect(_window: bigint, address: Pointer) {
        const rect = view(address, 16);
        [
          windowRect.left,
          windowRect.top,
          windowRect.right,
          windowRect.bottom,
        ].forEach((value, index) => {
          rect.setInt32(index * 4, value, true);
        });
        return 1;
      },
      SetWindowPos(
        _window: bigint,
        _after: bigint,
        left: number,
        top: number,
        width: number,
        height: number,
        flags: number,
      ) {
        positionFlags = flags;
        if (!(flags & SWP_NOMOVE)) {
          windowRect.left = left;
          windowRect.top = top;
        }
        if (!(flags & SWP_NOSIZE)) {
          windowRect.right = windowRect.left + width;
          windowRect.bottom = windowRect.top + height;
        }
        return 1;
      },
    },
  },
}));

const { Windows } = await import("#native/windows/bun/win32");
const windows = new Windows(() => {});
const constraints = {
  minWidth: 500,
  minHeight: 400,
  maxWidth: 800,
  maxHeight: 600,
};
const window = windows.create(
  "Fullscreen DPI",
  600,
  450,
  () => {},
  false,
  constraints,
);
const messages = linkSymbols({
  windowProcedure: {
    ptr: BigInt(callbackAddress),
    args: [
      "u64",
      "u32",
      "u64",
      "i64",
    ],
    returns: "i64",
  },
});
try {
  const secondary = monitors[1];
  assert(secondary);
  for (const queryWhileDisconnected of [
    false,
    true,
  ]) {
    // Display removal can relocate normal placement without leaving iconic or zoomed state.
    for (const state of [
      "minimized",
      "maximized",
    ]) {
      Object.assign(windowRect, {
        left: -1000,
        top: 100,
        right: -384,
        bottom: 589,
      });
      Object.assign(normalRect, windowRect);
      messages.symbols.windowProcedure(window, WM_WINDOWPOSCHANGED, 0n, 0n);
      minimized = state === "minimized";
      maximized = state === "maximized";
      removedMonitors.add(2n);
      Object.assign(normalRect, {
        left: 100,
        top: 200,
        right: 716,
        bottom: 689,
      });
      Object.assign(windowRect, normalRect);
      messages.symbols.windowProcedure(window, WM_DISPLAYCHANGE, 32n, 0n);
      messages.symbols.windowProcedure(window, WM_WINDOWPOSCHANGED, 0n, 0n);
      for (let query = 0; query < (queryWhileDisconnected ? 2 : 0); query++) {
        assert.deepEqual(windows.getBounds(window, "normal"), {
          x: 100,
          y: 200,
          width: 616,
          height: 489,
          dpi: 96,
        });
      }
      assert.equal(windows.failure, undefined);
      assert.equal(minimized, state === "minimized");
      assert.equal(maximized, state === "maximized");
      assert.equal((style & WS_VISIBLE) !== 0n, false);
      removedMonitors.clear();
      // Reconnecting the old display must not undo Windows' relocated normal placement.
      assert.deepEqual(windows.getBounds(window, "normal"), {
        x: 100,
        y: 200,
        width: 616,
        height: 489,
        dpi: 96,
      });
      minimized = false;
      maximized = false;
    }
  }
  const originalSecondary = {
    ...secondary,
  };
  // Normal moves must update the monitor; iconic and maximized moves must keep it.
  for (const layout of [
    {
      left: -2560,
      top: 0,
      right: 0,
      bottom: 1440,
      x: -300,
      y: 100,
    },
    {
      left: -2560,
      top: 0,
      right: 0,
      bottom: 1440,
      x: -320,
      y: 100,
    },
    {
      left: 0,
      top: -1440,
      right: 2560,
      bottom: 0,
      x: 100,
      y: -230,
    },
    {
      left: 0,
      top: -1440,
      right: 2560,
      bottom: 0,
      x: 100,
      y: -260,
    },
  ]) {
    Object.assign(secondary, {
      left: layout.left,
      top: layout.top,
      right: layout.right,
      bottom: layout.bottom,
    });
    Object.assign(windowRect, {
      left: layout.x,
      top: layout.y,
      right: layout.x + 600 + FRAME_WIDTH,
      bottom: layout.y + 450 + FRAME_HEIGHT,
    });
    Object.assign(normalRect, windowRect);
    messages.symbols.windowProcedure(window, WM_WINDOWPOSCHANGED, 0n, 0n);
    const expected = {
      x: layout.x,
      y: layout.y,
      width: 600 + FRAME_WIDTH,
      height: 450 + FRAME_HEIGHT,
      dpi: 96,
    };
    assert.deepEqual(windows.getBounds(window, "normal"), expected);
    for (const state of [
      "minimized",
      "maximized",
    ]) {
      minimized = state === "minimized";
      maximized = state === "maximized";
      Object.assign(windowRect, {
        left: secondary.left,
        top: secondary.top,
        right: secondary.right,
        bottom: secondary.bottom,
      });
      messages.symbols.windowProcedure(window, WM_WINDOWPOSCHANGED, 0n, 0n);
      assert.deepEqual(windows.getBounds(window, "normal"), expected);
      assert.equal(windows.failure, undefined);
    }
    minimized = false;
    maximized = false;
  }
  Object.assign(secondary, originalSecondary);
  Object.assign(windowRect, {
    left: -300,
    top: 100,
    right: 316,
    bottom: 589,
  });
  Object.assign(normalRect, windowRect);
  messages.symbols.windowProcedure(window, WM_WINDOWPOSCHANGED, 0n, 0n);
  // This substitute ignores maximize; the HWND postcondition must report a bounded failure.
  assert.deepEqual(
    hostResponse(() => {
      windows.maximize(window);
      return null;
    }),
    {
      kind: "error",
      error: {
        code: "INTERNAL",
        message: "Host operation failed.",
      },
    },
  );
  windows.show(window, false);
  const expectedNormal = {
    x: -300,
    y: 100,
    width: 616,
    height: 489,
    dpi: 96,
  };
  assert.deepEqual(windows.getBounds(window, "normal"), expectedNormal);
  // A normal placement drops stale maximize history; a minimized one keeps it.
  for (const wasMinimized of [
    false,
    true,
  ]) {
    minimized = wasMinimized;
    windows.show(window, false);
    windows.setFullscreen(window, true);
    windows.setFullscreen(window, false);
    assert.equal(windows.isFullscreen(window), false);
    assert.equal(windows.isVisible(window), false);
    assert.equal(windows.isMinimized(window), wasMinimized);
    assert.equal(windows.isMaximized(window), false);
    assert.deepEqual(windows.getBounds(window, "normal"), expectedNormal);
  }
  minimized = false;
  // Moving a maximized HWND does not move its saved normal rectangle.
  maximized = true;
  Object.assign(windowRect, {
    left: secondary.left,
    top: secondary.top,
    right: secondary.right,
    bottom: secondary.bottom,
  });
  for (const visible of [
    false,
    true,
  ]) {
    windows.show(window, visible);
    assert.deepEqual(windows.getBounds(window, "normal"), expectedNormal);
    assert.equal((style & WS_VISIBLE) !== 0n, visible);
  }
  windows.setFullscreen(window, true);
  assert.deepEqual(windows.getBounds(window, "normal"), expectedNormal);
  // Start the existing DPI scenarios on the normal rectangle's monitor.
  const primary = monitors[0];
  assert(primary);
  Object.assign(windowRect, {
    left: primary.left,
    top: primary.top,
    right: primary.right,
    bottom: primary.bottom,
  });
  // Move a fullscreen window between simulated monitors at both visibility states.
  for (const visible of [
    false,
    true,
  ]) {
    windows.show(window, visible);
    for (const [index, monitor] of monitors.entries()) {
      // The target position is not committed when the DPI callback runs.
      const target = monitors[1 - index];
      assert(target);
      assert.equal(monitorFor(windowRect), BigInt(index + 1));
      const suggested = new Int32Array([
        target.left + 32,
        target.top + 32,
        target.left + 900,
        target.top + 700,
      ]);
      messages.symbols.windowProcedure(
        window,
        WM_DPICHANGED,
        BigInt(target.dpi),
        BigInt(ptr(suggested)),
      );
      assert.equal(windows.failure, undefined);
      assert.deepEqual(windowRect, {
        left: target.left,
        top: target.top,
        right: target.right,
        bottom: target.bottom,
      });
      assert.equal((style & WS_VISIBLE) !== 0n, visible);
      assert(
        positionFlags & SWP_NOACTIVATE,
        "DPI changes must not activate the window.",
      );
      assert(windows.isFullscreen(window));
      assert.deepEqual(windows.getSizeConstraints(window), constraints);
      assert.deepEqual(windows.getBounds(window, "outer"), {
        x: target.left,
        y: target.top,
        width: target.right - target.left,
        height: target.bottom - target.top,
        dpi: target.dpi,
      });
      assert.deepEqual(windows.getBounds(window, "normal"), {
        x: -300,
        y: 100,
        width: Math.round((600 * target.dpi) / 96) + FRAME_WIDTH,
        height: Math.round((450 * target.dpi) / 96) + FRAME_HEIGHT,
        dpi: target.dpi,
      });
      assert.notEqual(target.dpi, monitor.dpi);
    }
  }
  // Fullscreen keeps its saved placement across repeated removal and reconnection.
  for (const visible of [
    false,
    true,
  ]) {
    windows.show(window, visible);
    for (let cycle = 0; cycle < 2; cycle++) {
      removedMonitors.add(primary.handle);
      Object.assign(windowRect, secondary);
      messages.symbols.windowProcedure(window, WM_DISPLAYCHANGE, 32n, 0n);
      messages.symbols.windowProcedure(window, WM_WINDOWPOSCHANGED, 0n, 0n);
      for (let query = 0; query < 2; query++) {
        assert.deepEqual(windows.getBounds(window, "normal"), {
          x: -324,
          y: 60,
          width: 616,
          height: 489,
          dpi: 96,
        });
      }
      removedMonitors.delete(primary.handle);
      // A reconnected display can receive a new HMONITOR; also retain same-handle coverage.
      if (cycle === 1) {
        primary.handle += 2n;
      }
      messages.symbols.windowProcedure(window, WM_DISPLAYCHANGE, 32n, 0n);
      messages.symbols.windowProcedure(window, WM_WINDOWPOSCHANGED, 0n, 0n);
      for (let query = 0; query < 2; query++) {
        assert.deepEqual(windows.getBounds(window, "normal"), expectedNormal);
      }
      assert(windows.isFullscreen(window));
      assert.equal((style & WS_VISIBLE) !== 0n, visible);
      assert.equal(windows.failure, undefined);
    }
  }
  removedMonitors.add(primary.handle);
  removedMonitors.add(secondary.handle);
  assert.deepEqual(
    hostResponse(() => windows.getBounds(window, "normal")),
    {
      kind: "error",
      error: {
        code: "INTERNAL",
        message: "Host operation failed.",
      },
    },
  );
} finally {
  messages.close();
  windows.destroy(window);
  windows.dispose();
}
