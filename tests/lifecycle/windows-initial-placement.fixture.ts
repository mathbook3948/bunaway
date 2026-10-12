import { type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { mock } from "bun:test";
import assert from "node:assert/strict";
import type { WindowSpec } from "@bunaway/plugin-api/native";
import { centerInWorkArea } from "#native/windows/bun/window-placement";
import { physicalPixels } from "#native/windows/bun/window-size";

// Isolate the DLL substitute from tests that load the real Win32 bindings.
const CW_USEDEFAULT = -2147483648;
const SWP_NOMOVE = 0x2;
const FRAME_WIDTH = 16;
const FRAME_HEIGHT = 39;
const monitors = [
  {
    handle: 1n,
    x: 0,
    y: 40,
    width: 1920,
    height: 1040,
    dpi: 96,
  },
  {
    handle: 2n,
    x: -2560,
    y: 0,
    width: 2560,
    height: 1440,
    dpi: 144,
  },
];
let nextWindow = 1n;
let windowDpi = 96;
let rect = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
};

function data(address: Pointer, size: number) {
  return new DataView(toArrayBuffer(address, 0, size));
}

/** Match Windows' largest-overlap selection independently of the requested point. */
function windowMonitor() {
  let largestOverlap = -1;
  let selected = monitors[0];
  for (const monitor of monitors) {
    const width = Math.max(
      0,
      Math.min(rect.x + rect.width, monitor.x + monitor.width) -
        Math.max(rect.x, monitor.x),
    );
    const height = Math.max(
      0,
      Math.min(rect.y + rect.height, monitor.y + monitor.height) -
        Math.max(rect.y, monitor.y),
    );
    if (width * height > largestOverlap) {
      largestOverlap = width * height;
      selected = monitor;
    }
  }
  assert(selected);
  return selected;
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
    },
  },
  display: {
    symbols: {
      GetDpiForMonitor(handle: bigint, _kind: number, x: Pointer, y: Pointer) {
        const monitor = monitors.find((monitor) => monitor.handle === handle);
        assert(monitor);
        data(x, 4).setUint32(0, monitor.dpi, true);
        data(y, 4).setUint32(0, monitor.dpi, true);
        return 0;
      },
    },
  },
  user: {
    symbols: {
      LoadIconW: () => 1n,
      SetThreadDpiAwarenessContext: () => -4n,
      RegisterClassExW: () => 1,
      UnregisterClassW: () => 1,
      CreateWindowExW(
        _ex: number,
        _class: Pointer,
        _title: Pointer,
        _style: number,
        x: number,
        y: number,
        width: number,
        height: number,
      ) {
        // Model OS-default placement on secondary as well as explicit coordinates.
        rect = {
          x: x === CW_USEDEFAULT ? -2200 : x,
          y: y === CW_USEDEFAULT ? 100 : y,
          width,
          height,
        };
        windowDpi = windowMonitor().dpi;
        return nextWindow++;
      },
      DestroyWindow: () => 1,
      IsWindow: () => 1,
      IsIconic: () => 0,
      IsZoomed: () => 0,
      GetDpiForWindow: () => windowDpi,
      MonitorFromWindow: (window: bigint) =>
        window ? windowMonitor().handle : 1n,
      MonitorFromPoint(point: bigint) {
        return Number(BigInt.asIntN(32, point)) < 0 ? 2n : 1n;
      },
      GetMonitorInfoW(handle: bigint, address: Pointer) {
        const monitor = monitors.find((monitor) => monitor.handle === handle);
        assert(monitor);
        const info = data(address, 40);
        [
          monitor.x,
          monitor.y,
          monitor.x + monitor.width,
          monitor.y + monitor.height,
        ].forEach((value, index) => {
          info.setInt32(20 + index * 4, value, true);
          info.setInt32(4 + index * 4, value, true);
        });
        return 1;
      },
      AdjustWindowRectExForDpi(
        address: Pointer,
        _style: number,
        _menu: number,
        _ex: number,
        dpi: number,
      ) {
        const bounds = data(address, 16);
        bounds.setInt32(
          8,
          bounds.getInt32(8, true) + physicalPixels(FRAME_WIDTH, dpi),
          true,
        );
        bounds.setInt32(
          12,
          bounds.getInt32(12, true) + physicalPixels(FRAME_HEIGHT, dpi),
          true,
        );
        return 1;
      },
      SetWindowPos(
        _window: bigint,
        _after: bigint,
        x: number,
        y: number,
        width: number,
        height: number,
        flags: number,
      ) {
        rect = {
          x: flags & SWP_NOMOVE ? rect.x : x,
          y: flags & SWP_NOMOVE ? rect.y : y,
          width,
          height,
        };
        return 1;
      },
      GetWindowRect(_window: bigint, address: Pointer) {
        const bounds = data(address, 16);
        [
          rect.x,
          rect.y,
          rect.x + rect.width,
          rect.y + rect.height,
        ].forEach((value, index) => {
          bounds.setInt32(index * 4, value, true);
        });
        return 1;
      },
    },
  },
}));

const { Windows } = await import("#native/windows/bun/win32");
const windows = new Windows(() => {});
function create(options: WindowSpec["window"]) {
  return windows.create(
    "Mixed DPI placement",
    options.width,
    options.height,
    () => {},
    false,
    options,
  );
}

try {
  const primary = monitors[0];
  const secondary = monitors[1];
  assert(primary && secondary);
  for (const primaryDpi of [
    96,
    144,
  ]) {
    primary.dpi = primaryDpi;
    secondary.dpi = primaryDpi === 96 ? 144 : 96;
    for (const useContentSize of [
      true,
      false,
    ]) {
      const hwnd = create({
        width: 600,
        height: 450,
        x: -100,
        y: 100,
        useContentSize,
      });
      try {
        // The point selects secondary, but most of the new HWND occupies primary.
        assert.equal(windows.getDpi(hwnd), primaryDpi);
        const bounds = windows.getBounds(hwnd, "outer");
        assert.deepEqual(
          {
            x: bounds.x,
            y: bounds.y,
            dpi: bounds.dpi,
          },
          {
            x: -100,
            y: 100,
            dpi: primaryDpi,
          },
        );
        const expectedWidth =
          physicalPixels(600, primaryDpi) +
          (useContentSize ? physicalPixels(FRAME_WIDTH, primaryDpi) : 0);
        const expectedHeight =
          physicalPixels(450, primaryDpi) +
          (useContentSize ? physicalPixels(FRAME_HEIGHT, primaryDpi) : 0);
        // Outer sizing passes through logical content rounding; tolerate one physical pixel.
        assert(Math.abs(bounds.width - expectedWidth) <= 1);
        assert(Math.abs(bounds.height - expectedHeight) <= 1);
      } finally {
        windows.destroy(hwnd);
      }
    }
  }
  primary.dpi = 96;
  secondary.dpi = 144;
  const defaultWindow = create({
    width: 600,
    height: 450,
  });
  try {
    assert.deepEqual(windows.getBounds(defaultWindow, "outer"), {
      x: -2200,
      y: 100,
      width: 924,
      height: 734,
      dpi: 144,
    });
  } finally {
    windows.destroy(defaultWindow);
  }

  // Oversized centering can overlap secondary most, but must retain primary rcWork.
  primary.dpi = 144;
  secondary.dpi = 96;
  const centered = create({
    width: 4096,
    height: 400,
    center: true,
  });
  try {
    const bounds = windows.getBounds(centered, "outer");
    assert.equal(bounds.dpi, 96);
    assert.deepEqual(
      {
        x: bounds.x,
        y: bounds.y,
      },
      centerInWorkArea(primary, bounds.width, bounds.height),
    );
  } finally {
    windows.destroy(centered);
  }
  assert.equal(windows.failure, undefined);
} finally {
  windows.dispose();
}
