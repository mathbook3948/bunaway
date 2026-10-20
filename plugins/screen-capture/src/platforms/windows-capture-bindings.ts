import { dlopen, JSCallback, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { GDI32, pick, USER32 } from "@bunaway/plugin/win32";
import { MAX_SOURCE_NAME_CHARS } from "#screen-capture/contract";
import type {
  CaptureBindings,
  Dib,
  MonitorFacts,
  Rect,
  WindowFacts,
} from "#screen-capture/platforms/windows-capture";

/** DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, a pseudo handle. */
const PER_MONITOR_AWARE_V2 = -4n;
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x80n;
const GW_OWNER = 4;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const PW_RENDERFULLCONTENT = 2;
const SRCCOPY = 0x00cc0020;
/** Also copy layered (transparent or composited) windows when the source is the screen. */
const CAPTUREBLT = 0x40000000;
const HALFTONE = 4;
const DIB_RGB_COLORS = 0;
const BI_RGB = 0;
const BITMAPINFOHEADER_BYTES = 40;
const BYTES_PER_PIXEL = 4;
const RECT_BYTES = 16;
const MONITORINFOEXW_BYTES = 104;
const MONITOR_RECT_OFFSET = 4;
const MONITOR_DEVICE_OFFSET = 40;
const MONITOR_DEVICE_BYTES = 64;
/** Reported for a window whose display affinity cannot be read, so the capture is refused. */
const UNKNOWN_DISPLAY_AFFINITY = -1;
/** A title is read slightly past the contract limit so the adapter can still cut it on a character boundary. */
const TITLE_BUFFER_CHARS = MAX_SOURCE_NAME_CHARS + 2;
const EXIT_CONTINUE = 1;

/** Open the three libraries the capture calls; the caller owns them and closes them on dispose. */
export function openCaptureLibraries() {
  const user32 = dlopen("user32.dll", {
    ...pick(USER32, "GetDC", "ReleaseDC"),
    EnumWindows: {
      args: [
        "ptr",
        "i64",
      ],
      returns: "i32",
    },
    GetWindowThreadProcessId: {
      args: [
        "u64",
        "ptr",
      ],
      returns: "u32",
    },
    GetWindowTextW: {
      args: [
        "u64",
        "ptr",
        "i32",
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
    IsWindow: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
    GetWindow: {
      args: [
        "u64",
        "u32",
      ],
      returns: "u64",
    },
    GetWindowLongPtrW: {
      args: [
        "u64",
        "i32",
      ],
      returns: "i64",
    },
    GetWindowDisplayAffinity: {
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
    EnumDisplayMonitors: {
      args: [
        "u64",
        "ptr",
        "ptr",
        "i64",
      ],
      returns: "i32",
    },
    GetMonitorInfoW: {
      args: [
        "u64",
        "ptr",
      ],
      returns: "i32",
    },
    SetThreadDpiAwarenessContext: {
      args: [
        "i64",
      ],
      returns: "i64",
    },
    PrintWindow: {
      args: [
        "u64",
        "u64",
        "u32",
      ],
      returns: "i32",
    },
    IsHungAppWindow: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
    GetShellWindow: {
      args: [],
      returns: "u64",
    },
  });
  try {
    const gdi32 = dlopen("gdi32.dll", {
      ...GDI32,
      BitBlt: {
        args: [
          "u64",
          "i32",
          "i32",
          "i32",
          "i32",
          "u64",
          "i32",
          "i32",
          "u32",
        ],
        returns: "i32",
      },
      StretchBlt: {
        args: [
          "u64",
          "i32",
          "i32",
          "i32",
          "i32",
          "u64",
          "i32",
          "i32",
          "i32",
          "i32",
          "u32",
        ],
        returns: "i32",
      },
      SetStretchBltMode: {
        args: [
          "u64",
          "i32",
        ],
        returns: "i32",
      },
      SetBrushOrgEx: {
        args: [
          "u64",
          "i32",
          "i32",
          "ptr",
        ],
        returns: "i32",
      },
    });
    try {
      const dwmapi = dlopen("dwmapi.dll", {
        DwmGetWindowAttribute: {
          args: [
            "u64",
            "u32",
            "ptr",
            "u32",
          ],
          returns: "i32",
        },
      });
      return {
        user32,
        gdi32,
        dwmapi,
      };
    } catch (error) {
      gdi32.close();
      throw error;
    }
  } catch (error) {
    user32.close();
    throw error;
  }
}

export type CaptureLibraries = ReturnType<typeof openCaptureLibraries>;

function readRect(buffer: Buffer): Rect {
  const left = buffer.readInt32LE(0);
  const top = buffer.readInt32LE(4);
  return {
    x: left,
    y: top,
    width: buffer.readInt32LE(8) - left,
    height: buffer.readInt32LE(12) - top,
  };
}

/** Wrap the loaded libraries in the narrow interface the capture logic is written against. */
export function captureBindings(libraries: CaptureLibraries): CaptureBindings {
  const { user32, gdi32, dwmapi } = libraries;
  const frameAttribute = (window: bigint, attribute: number, out: Buffer) =>
    dwmapi.symbols.DwmGetWindowAttribute(
      window,
      attribute,
      ptr(out),
      out.length,
    );

  const windowRect = (window: bigint): Rect | null => {
    const rect = Buffer.alloc(RECT_BYTES);
    return user32.symbols.GetWindowRect(window, ptr(rect)) === 0
      ? null
      : readRect(rect);
  };
  const frameRect = (window: bigint): Rect | null => {
    const rect = Buffer.alloc(RECT_BYTES);
    return frameAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, rect) < 0
      ? null
      : readRect(rect);
  };
  const isCloaked = (window: bigint): boolean => {
    const cloaked = Buffer.alloc(4);
    return (
      frameAttribute(window, DWMWA_CLOAKED, cloaked) >= 0 &&
      cloaked.readUInt32LE(0) !== 0
    );
  };
  const displayAffinity = (window: bigint): number => {
    const affinity = Buffer.alloc(4);
    return user32.symbols.GetWindowDisplayAffinity(window, ptr(affinity)) === 0
      ? UNKNOWN_DISPLAY_AFFINITY
      : affinity.readUInt32LE(0);
  };
  const title = (window: bigint): string => {
    const text = Buffer.alloc(TITLE_BUFFER_CHARS * 2);
    const copied = user32.symbols.GetWindowTextW(
      window,
      ptr(text),
      TITLE_BUFFER_CHARS,
    );
    return text.toString("utf16le", 0, Math.max(0, copied) * 2);
  };

  return {
    setDpiAwareness() {
      return BigInt(
        user32.symbols.SetThreadDpiAwarenessContext(PER_MONITOR_AWARE_V2),
      );
    },
    restoreDpiAwareness(previous) {
      return user32.symbols.SetThreadDpiAwarenessContext(previous) !== 0n;
    },
    listWindows() {
      const windows: bigint[] = [];
      // The callback only appends a handle, so no JavaScript error can unwind through the Win32 frame.
      const callback = new JSCallback(
        (window: bigint) => {
          windows.push(window);
          return EXIT_CONTINUE;
        },
        {
          args: [
            "u64",
            "i64",
          ],
          returns: "i32",
        },
      );
      try {
        if (user32.symbols.EnumWindows(callback.ptr, 0n) === 0) {
          throw new Error("EnumWindows failed.");
        }
      } finally {
        callback.close();
      }
      return windows;
    },
    shellWindow: () => user32.symbols.GetShellWindow(),
    windowFacts(window): WindowFacts | null {
      if (user32.symbols.IsWindow(window) === 0) {
        return null;
      }
      const full = windowRect(window);
      if (full === null) {
        return null;
      }
      const process = new Uint32Array(1);
      const thread = user32.symbols.GetWindowThreadProcessId(
        window,
        ptr(process),
      );
      const exStyle = BigInt(
        user32.symbols.GetWindowLongPtrW(window, GWL_EXSTYLE),
      );
      const visible = user32.symbols.IsWindowVisible(window) !== 0;
      const hasOwner = user32.symbols.GetWindow(window, GW_OWNER) !== 0n;
      const toolWindow = (exStyle & WS_EX_TOOLWINDOW) !== 0n;
      return {
        // Only a window that can be listed needs its title; reading it sends a message to the owning thread.
        title: visible && !hasOwner && !toolWindow ? title(window) : "",
        visible,
        minimized: user32.symbols.IsIconic(window) !== 0,
        cloaked: isCloaked(window),
        hasOwner,
        toolWindow,
        displayAffinity: displayAffinity(window),
        hung: user32.symbols.IsHungAppWindow(window) !== 0,
        pid: process[0] ?? 0,
        tid: thread,
        windowRect: full,
        frameRect: frameRect(window),
      };
    },
    listMonitors() {
      const monitors: MonitorFacts[] = [];
      let failure: unknown;
      const callback = new JSCallback(
        (monitor: bigint) => {
          try {
            const info = Buffer.alloc(MONITORINFOEXW_BYTES);
            info.writeUInt32LE(MONITORINFOEXW_BYTES);
            if (user32.symbols.GetMonitorInfoW(monitor, ptr(info)) === 0) {
              throw new Error("GetMonitorInfoW failed.");
            }
            const device = info
              .toString(
                "utf16le",
                MONITOR_DEVICE_OFFSET,
                MONITOR_DEVICE_OFFSET + MONITOR_DEVICE_BYTES,
              )
              .split("\0", 1)[0];
            monitors.push({
              deviceName: device ?? "",
              bounds: readRect(
                info.subarray(
                  MONITOR_RECT_OFFSET,
                  MONITOR_RECT_OFFSET + RECT_BYTES,
                ),
              ),
            });
            return EXIT_CONTINUE;
          } catch (error) {
            failure = error;
            return 0;
          }
        },
        {
          args: [
            "u64",
            "u64",
            "ptr",
            "i64",
          ],
          returns: "i32",
        },
      );
      try {
        const done = user32.symbols.EnumDisplayMonitors(
          0n,
          null,
          callback.ptr,
          0n,
        );
        if (failure !== undefined) {
          throw failure;
        }
        if (done === 0) {
          throw new Error("EnumDisplayMonitors failed.");
        }
      } finally {
        callback.close();
      }
      return monitors;
    },
    getScreenDc: () => user32.symbols.GetDC(0n),
    releaseScreenDc: (dc) => user32.symbols.ReleaseDC(0n, dc) !== 0,
    createMemoryDc: (compatible) =>
      gdi32.symbols.CreateCompatibleDC(compatible),
    deleteDc: (dc) => gdi32.symbols.DeleteDC(dc) !== 0,
    createDib(compatible, width, height): Dib | null {
      // A negative height makes the bitmap top-down, so rows read in raster order.
      const header = Buffer.alloc(BITMAPINFOHEADER_BYTES);
      header.writeUInt32LE(BITMAPINFOHEADER_BYTES, 0);
      header.writeInt32LE(width, 4);
      header.writeInt32LE(-height, 8);
      header.writeUInt16LE(1, 12);
      header.writeUInt16LE(BYTES_PER_PIXEL * 8, 14);
      header.writeUInt32LE(BI_RGB, 16);
      const bits = Buffer.alloc(8);
      const bitmap = gdi32.symbols.CreateDIBSection(
        compatible,
        ptr(header),
        DIB_RGB_COLORS,
        ptr(bits),
        0n,
        0,
      );
      const address = Number(bits.readBigUInt64LE(0));
      if (bitmap === 0n || address === 0) {
        if (bitmap !== 0n) {
          gdi32.symbols.DeleteObject(bitmap);
        }
        return null;
      }
      return {
        bitmap,
        // The view aliases memory owned by the bitmap, so it is read only before the bitmap is deleted.
        pixels: new Uint8Array(
          toArrayBuffer(
            address as Pointer,
            0,
            width * height * BYTES_PER_PIXEL,
          ),
        ),
      };
    },
    selectObject: (dc, object) => gdi32.symbols.SelectObject(dc, object),
    deleteObject: (object) => gdi32.symbols.DeleteObject(object) !== 0,
    flush() {
      gdi32.symbols.GdiFlush();
    },
    printWindow: (window, dc) =>
      user32.symbols.PrintWindow(window, dc, PW_RENDERFULLCONTENT) !== 0,
    blit(target, targetSize, source, sourceRect, fromScreen) {
      const operation = fromScreen ? SRCCOPY | CAPTUREBLT : SRCCOPY;
      if (
        targetSize.width === sourceRect.width &&
        targetSize.height === sourceRect.height
      ) {
        return (
          gdi32.symbols.BitBlt(
            target,
            0,
            0,
            targetSize.width,
            targetSize.height,
            source,
            sourceRect.x,
            sourceRect.y,
            operation,
          ) !== 0
        );
      }
      // HALFTONE averages source pixels when shrinking; it needs the brush origin reset afterwards.
      gdi32.symbols.SetStretchBltMode(target, HALFTONE);
      gdi32.symbols.SetBrushOrgEx(target, 0, 0, null);
      return (
        gdi32.symbols.StretchBlt(
          target,
          0,
          0,
          targetSize.width,
          targetSize.height,
          source,
          sourceRect.x,
          sourceRect.y,
          sourceRect.width,
          sourceRect.height,
          operation,
        ) !== 0
      );
    },
  };
}
