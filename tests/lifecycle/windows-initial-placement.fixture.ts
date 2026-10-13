import { linkSymbols, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { mock } from "bun:test";
import assert from "node:assert/strict";
import type { WindowSpec } from "@bunaway/plugin-api/native";
import { centerInWorkArea } from "#native/windows/bun/window-placement";
import { physicalPixels } from "#native/windows/bun/window-size";

// Isolate the DLL substitute from tests that load the real Win32 bindings.
const CW_USEDEFAULT = -2147483648;
const WM_DPICHANGED = 0x02e0;
const WM_GETMINMAXINFO = 0x0024;
const SWP_NOMOVE = 0x2;
const SWP_NOSIZE = 0x1;
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
let callbackAddress = 0;
let dpiChanges = 0;
let positionCalls = 0;
let destroyedWindows = 0;
let shownWindows = 0;
let enforceTrackingLimits = false;
let ignoreRequestedSize = false;
const trackingLimits = {
  minWidth: 112,
  minHeight: 39,
  maxWidth: 1936,
  maxHeight: 1096,
};
let rect = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
};

function data(address: Pointer, size: number) {
  return new DataView(toArrayBuffer(address, 0, size));
}

/** Ask the real window procedure to override defaults before native size clamping. */
function readTrackingLimits(window: bigint) {
  const info = new Int32Array(10);
  info[6] = trackingLimits.minWidth;
  info[7] = trackingLimits.minHeight;
  info[8] = trackingLimits.maxWidth;
  info[9] = trackingLimits.maxHeight;
  messages.symbols.windowProcedure(
    window,
    WM_GETMINMAXINFO,
    0n,
    BigInt(ptr(info)),
  );
  return {
    minWidth: info[6],
    minHeight: info[7],
    maxWidth: info[8],
    maxHeight: info[9],
  };
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
      RegisterWindowMessageW: () => 0xc000,
      SetThreadDpiAwarenessContext: () => -4n,
      RegisterClassExW(address: Pointer) {
        callbackAddress = Number(data(address, 80).getBigUint64(8, true));
        return 1;
      },
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
      DestroyWindow() {
        destroyedWindows++;
        return 1;
      },
      IsWindow: () => 1,
      IsIconic: () => 0,
      IsZoomed: () => 0,
      IsWindowVisible: () => 0,
      ShowWindow(_window: bigint, command: number) {
        if (command !== 0) {
          shownWindows++;
        }
        return 1;
      },
      GetWindowLongPtrW: (_window: bigint, kind: number) =>
        kind === -16 ? 0x00cf0000n : 0n,
      GetClientRect(_window: bigint, address: Pointer) {
        const bounds = data(address, 16);
        bounds.setInt32(
          8,
          rect.width - physicalPixels(FRAME_WIDTH, windowDpi),
          true,
        );
        bounds.setInt32(
          12,
          rect.height - physicalPixels(FRAME_HEIGHT, windowDpi),
          true,
        );
        return 1;
      },
      GetDpiForWindow: () => windowDpi,
      DefWindowProcW: () => 0n,
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
        positionCalls++;
        if (enforceTrackingLimits && !(flags & SWP_NOSIZE)) {
          const limits = readTrackingLimits(_window);
          width = Math.max(limits.minWidth, Math.min(limits.maxWidth, width));
          height = Math.max(
            limits.minHeight,
            Math.min(limits.maxHeight, height),
          );
        }
        if (ignoreRequestedSize && !(flags & SWP_NOSIZE)) {
          width--;
        }
        rect = {
          x: flags & SWP_NOMOVE ? rect.x : x,
          y: flags & SWP_NOMOVE ? rect.y : y,
          width: flags & SWP_NOSIZE ? rect.width : width,
          height: flags & SWP_NOSIZE ? rect.height : height,
        };
        const dpi = windowMonitor().dpi;
        if (dpi !== windowDpi) {
          const previousDpi = windowDpi;
          windowDpi = dpi;
          dpiChanges++;
          const suggested = new Int32Array([
            rect.x,
            rect.y,
            rect.x + Math.round((rect.width * dpi) / previousDpi),
            rect.y + Math.round((rect.height * dpi) / previousDpi),
          ]);
          messages.symbols.windowProcedure(
            _window,
            WM_DPICHANGED,
            BigInt(dpi),
            BigInt(ptr(suggested)),
          );
        }
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

  // These centered sizes alternate between the two monitor DPIs indefinitely.
  primary.dpi = 144;
  secondary.dpi = 96;
  const previousDestroyed = destroyedWindows;
  const previousCalls = positionCalls;
  assert.throws(
    () =>
      create({
        width: 4096,
        height: 400,
        center: true,
      }),
    /cannot settle across monitor DPI changes/,
  );
  assert.equal(destroyedWindows, previousDestroyed + 1);
  assert.equal(positionCalls, previousCalls + 2);
  assert.equal(shownWindows, 0);
  assert.equal(windows.failure, undefined);

  // A third monitor makes the next DPI transition converge. Keep primary rcWork
  // while recalculating requested content/outer sizes at the final HWND DPI.
  Object.assign(primary, {
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    dpi: 96,
  });
  Object.assign(secondary, {
    x: -1920,
    y: 122,
    width: 1920,
    height: 1399,
    dpi: 120,
  });
  monitors.push({
    handle: 3n,
    x: 800,
    y: -132,
    width: 1920,
    height: 837,
    dpi: 144,
  });
  for (const useContentSize of [
    true,
    false,
  ]) {
    const previousChanges = dpiChanges;
    const hwnd = create({
      width: 3458,
      height: 1160,
      center: true,
      useContentSize,
    });
    try {
      const bounds = windows.getBounds(hwnd, "outer");
      assert(dpiChanges > previousChanges);
      assert.equal(bounds.dpi, 120);
      assert.equal(bounds.dpi, windowDpi);
      assert.deepEqual(
        {
          x: bounds.x,
          y: bounds.y,
        },
        centerInWorkArea(primary, bounds.width, bounds.height),
      );
      assert(
        Math.abs(
          bounds.width -
            (physicalPixels(3458, bounds.dpi) +
              (useContentSize ? physicalPixels(FRAME_WIDTH, bounds.dpi) : 0)),
        ) <= 1,
      );
      assert(
        Math.abs(
          bounds.height -
            (physicalPixels(1160, bounds.dpi) +
              (useContentSize ? physicalPixels(FRAME_HEIGHT, bounds.dpi) : 0)),
        ) <= 1,
      );
    } finally {
      windows.destroy(hwnd);
    }
  }

  // A later runtime DPI change follows the OS suggestion, not the creation center.
  const centered = create({
    width: 600,
    height: 400,
    center: true,
  });
  try {
    windowDpi = 144;
    const suggested = new Int32Array([
      900,
      100,
      1200,
      400,
    ]);
    messages.symbols.windowProcedure(
      centered,
      WM_DPICHANGED,
      144n,
      BigInt(ptr(suggested)),
    );
    const bounds = windows.getBounds(centered, "outer");
    assert.equal(bounds.dpi, 144);
    assert.deepEqual(
      {
        x: bounds.x,
        y: bounds.y,
      },
      {
        x: 900,
        y: 100,
      },
    );
  } finally {
    windows.destroy(centered);
  }
  assert.equal(windows.failure, undefined);

  // Model a single display's default tracking limits. Initial placement must
  // preserve oversized requests, while ordinary resizing keeps those defaults.
  monitors.splice(1);
  Object.assign(primary, {
    x: 0,
    y: 40,
    width: 1920,
    height: 1040,
    dpi: 96,
  });
  enforceTrackingLimits = true;
  for (const useContentSize of [
    true,
    false,
  ]) {
    const hwnd = create({
      width: 3000,
      height: 2000,
      center: true,
      useContentSize,
    });
    try {
      const bounds = windows.getBounds(hwnd, "outer");
      assert.equal(bounds.width, 3000 + (useContentSize ? FRAME_WIDTH : 0));
      assert.equal(bounds.height, 2000 + (useContentSize ? FRAME_HEIGHT : 0));
      const center = centerInWorkArea(primary, bounds.width, bounds.height);
      assert.equal(bounds.x, center.x);
      assert.equal(bounds.y, center.y);
      assert.deepEqual(readTrackingLimits(hwnd), trackingLimits);
    } finally {
      windows.destroy(hwnd);
    }
  }

  // Overflow fitting can produce a valid rectangle smaller than the system's
  // caption minimum. It must not expand back outside the selected work area.
  primary.width = 100;
  const fitted = create({
    width: 800,
    height: 600,
    preventOverflow: true,
  });
  try {
    const bounds = windows.getBounds(fitted, "outer");
    assert.equal(bounds.width, primary.width);
    assert.equal(bounds.x, primary.x);
    assert.deepEqual(readTrackingLimits(fitted), trackingLimits);
  } finally {
    windows.destroy(fitted);
  }

  // A successful SetWindowPos return alone does not prove the rectangle was applied.
  primary.width = 1920;
  ignoreRequestedSize = true;
  const destroyedBeforeMismatch = destroyedWindows;
  assert.throws(
    () =>
      create({
        width: 600,
        height: 400,
        center: true,
      }),
    /did not apply the initial window rectangle/,
  );
  assert.equal(destroyedWindows, destroyedBeforeMismatch + 1);
  assert.equal(shownWindows, 0);
  assert.equal(windows.failure, undefined);
} finally {
  windows.dispose();
  messages.close();
}
