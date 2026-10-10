import { linkSymbols, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { hostResponse } from "#native/windows/bun/host-response";

// Isolate the DLL substitute from the real Windows callback tests.
const WM_DPICHANGED = 0x02e0;
const WS_OVERLAPPEDWINDOW = 0x00cf0000;
const WS_VISIBLE = 0x10000000n;
const GWL_STYLE = -16;
const SW_HIDE = 0;
const SW_SHOWNORMAL = 1;
const SW_SHOWMINIMIZED = 2;
const SWP_NOSIZE = 0x1;
const WPF_RESTORETOMAXIMIZED = 0x2;
const SWP_NOMOVE = 0x2;
const SWP_NOACTIVATE = 0x10;
const FRAME_WIDTH = 16;
const FRAME_HEIGHT = 39;
const monitors = [
  {
    left: 0,
    top: 0,
    right: 1920,
    bottom: 1080,
    dpi: 96,
  },
  {
    left: 1920,
    top: 0,
    right: 4480,
    bottom: 1440,
    dpi: 144,
  },
];
const windowRect = {
  left: 32,
  top: 32,
  right: 648,
  bottom: 521,
};
let style = BigInt(WS_OVERLAPPEDWINDOW);
let callbackAddress = 0;
let positionFlags = 0;
let minimized = false;

function view(address: Pointer, size: number) {
  return new DataView(toArrayBuffer(address, 0, size));
}

/** Selects the simulated monitor with the largest overlap with a window rectangle. */
function monitorFor(rect: typeof windowRect) {
  let largestArea = -1;
  let selected = 0;
  for (const [index, monitor] of monitors.entries()) {
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
  return BigInt(selected + 1);
}

function monitorInfo(handle: bigint) {
  const monitor = monitors[Number(handle) - 1];
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
      IsZoomed: () => 0,
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
        placement.setUint32(
          8,
          minimized ? SW_SHOWMINIMIZED : SW_SHOWNORMAL,
          true,
        );
        [
          windowRect.left,
          windowRect.top,
          windowRect.right,
          windowRect.bottom,
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
        windowRect.left = placement.getInt32(28, true);
        windowRect.top = placement.getInt32(32, true);
        windowRect.right = placement.getInt32(36, true);
        windowRect.bottom = placement.getInt32(40, true);
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
        const bounds = monitorInfo(monitor);
        const info = view(address, 40);
        [
          bounds.left,
          bounds.top,
          bounds.right,
          bounds.bottom,
        ].forEach((value, index) => {
          info.setInt32(4 + index * 4, value, true);
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
  windows.setFullscreen(window, true);
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
      assert.notEqual(target.dpi, monitor.dpi);
    }
  }
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
  }
} finally {
  messages.close();
  windows.destroy(window);
  windows.dispose();
}
