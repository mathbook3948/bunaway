import assert from "node:assert/strict";
import { JSCallback, ptr } from "bun:ffi";
import type { NativeMonitor, NativeMonitorServices } from "@bunaway/plugin-api/native";
import { display, hr, user, withWide } from "./win32-bindings.ts";

const MONITORINFOEXW_SIZE = 104;
const DISPLAY_DEVICEW_SIZE = 840;
const DEVMODEW_SIZE = 220;
const MONITOR_DEFAULTTOPRIMARY = 1;
const MONITOR_DEFAULTTONEAREST = 2;
const MONITORINFOF_PRIMARY = 1;
const ENUM_CURRENT_SETTINGS = 0xffffffff;
const DM_DISPLAYORIENTATION = 0x80;
const DM_DISPLAYFREQUENCY = 0x400000;

function text(buffer: Buffer, offset: number, size: number) {
  return buffer.toString("utf16le", offset, offset + size).split("\0", 1)[0] ?? "";
}
function rect(buffer: Buffer, offset: number) {
  const x = buffer.readInt32LE(offset);
  const y = buffer.readInt32LE(offset + 4);
  return {
    x, y,
    width: buffer.readInt32LE(offset + 8) - x,
    height: buffer.readInt32LE(offset + 12) - y,
  };
}

/** Read live metrics without caching native handles across display reconfiguration. */
export function readMonitor(handle: bigint): NativeMonitor {
  const info = Buffer.alloc(MONITORINFOEXW_SIZE);
  info.writeUInt32LE(MONITORINFOEXW_SIZE);
  assert(handle && user.symbols.GetMonitorInfoW(handle, ptr(info)), "Monitor is unavailable.");
  const id = text(info, 40, 64);
  assert(id, "Monitor device name is unavailable.");
  const device = Buffer.alloc(DISPLAY_DEVICEW_SIZE);
  device.writeUInt32LE(DISPLAY_DEVICEW_SIZE);
  const hasName = withWide(id, (name) => user.symbols.EnumDisplayDevicesW(name, 0, ptr(device), 0));
  const mode = Buffer.alloc(DEVMODEW_SIZE);
  mode.writeUInt16LE(DEVMODEW_SIZE, 68);
  const hasMode = withWide(id, (name) => user.symbols.EnumDisplaySettingsW(name, ENUM_CURRENT_SETTINGS, ptr(mode)));
  const fields = hasMode ? mode.readUInt32LE(72) : 0;
  const orientation = mode.readUInt32LE(84);
  const rotation = fields & DM_DISPLAYORIENTATION ? ([0, 90, 180, 270] as const)[orientation] ?? null : null;
  const frequency = mode.readUInt32LE(184);
  const x = Buffer.alloc(4);
  const y = Buffer.alloc(4);
  hr(display.symbols.GetDpiForMonitor(handle, 0, ptr(x), ptr(y)), "GetDpiForMonitor");
  const dpi = x.readUInt32LE();
  assert(dpi, "Monitor DPI is unavailable.");
  return {
    id, name: (hasName && text(device, 68, 256)) || id,
    primary: Boolean(info.readUInt32LE(36) & MONITORINFOF_PRIMARY),
    bounds: rect(info, 4), workArea: rect(info, 20),
    dpi, scaleFactor: dpi / 96, rotation,
    refreshRate: fields & DM_DISPLAYFREQUENCY && frequency > 1 ? frequency : null,
  };
}

/** Use Win32's largest-overlap rule and pre-minimize window rectangle. */
export function windowMonitor(hwnd: bigint): NativeMonitor {
  return readMonitor(user.symbols.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST));
}

/** Each query runs synchronously on the host's per-monitor-aware UI thread. */
export const monitorServices: NativeMonitorServices = {
  list() {
    const monitors: NativeMonitor[] = [];
    let failure: unknown;
    // Never unwind JavaScript errors through the Win32 callback boundary.
    const callback = new JSCallback((handle: bigint) => {
      try {
        monitors.push(readMonitor(handle));
        return 1;
      } catch (error) {
        failure = error;
        return 0;
      }
    }, { args: ["u64", "u64", "ptr", "i64"], returns: "i32" });
    try {
      const result = user.symbols.EnumDisplayMonitors(0n, null, callback.ptr, 0n);
      if (failure) { throw failure; }
      assert(result, "Monitor enumeration failed.");
      return monitors;
    } finally { callback.close(); }
  },
  primary() {
    return readMonitor(user.symbols.MonitorFromPoint(0n, MONITOR_DEFAULTTOPRIMARY));
  },
  nearestPoint({ x, y }) {
    // POINT is passed by value as one signed 64-bit argument on Windows x64.
    const point = Buffer.alloc(8);
    point.writeInt32LE(x); point.writeInt32LE(y, 4);
    return readMonitor(user.symbols.MonitorFromPoint(point.readBigInt64LE(), MONITOR_DEFAULTTONEAREST));
  },
  nearestRect({ x, y, width, height }) {
    const bounds = Buffer.alloc(16);
    bounds.writeInt32LE(x); bounds.writeInt32LE(y, 4);
    bounds.writeInt32LE(x + width, 8); bounds.writeInt32LE(y + height, 12);
    return readMonitor(user.symbols.MonitorFromRect(ptr(bounds), MONITOR_DEFAULTTONEAREST));
  },
  cursor() {
    const point = Buffer.alloc(8);
    assert(user.symbols.GetCursorPos(ptr(point)), "Cursor position is unavailable.");
    return { x: point.readInt32LE(), y: point.readInt32LE(4) };
  },
};
