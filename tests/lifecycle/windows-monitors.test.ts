import { expect, test } from "bun:test";
import { monitorSchema } from "@bunaway/plugin-windows";

test.skipIf(process.platform !== "win32")(
  "real Win32 monitors match native rectangles and select physical points, rectangles and minimized windows",
  async () => {
    const [{ Windows }, { monitorServices, windowMonitor }, { user }, { ptr }] =
      await Promise.all([
        import("#native/windows/bun/win32"),
        import("#native/windows/bun/monitors"),
        import("#native/windows/bun/win32-bindings"),
        import("bun:ffi"),
      ]);
    const native = new Windows(() => {});
    let hwnd = 0n;
    try {
      const monitors = monitorServices.list();
      expect(monitors.length).toBeGreaterThan(0);
      expect(new Set(monitors.map((monitor) => monitor.id)).size).toBe(
        monitors.length,
      );
      const primary = monitorServices.primary();
      expect(primary.primary).toBe(true);
      expect(
        monitors
          .filter((monitor) => monitor.primary)
          .map((monitor) => monitor.id),
      ).toEqual([
        primary.id,
      ]);
      for (const monitor of monitors) {
        expect(monitorSchema.parse(monitor)).toEqual(monitor);
        const point = {
          x: monitor.bounds.x,
          y: monitor.bounds.y,
        };
        expect(monitorServices.nearestPoint(point).id).toBe(monitor.id);
        expect(monitorServices.nearestRect(monitor.bounds).id).toBe(monitor.id);
        expect(monitor.workArea.x).toBeGreaterThanOrEqual(monitor.bounds.x);
        expect(monitor.workArea.y).toBeGreaterThanOrEqual(monitor.bounds.y);
        expect(monitor.workArea.x + monitor.workArea.width).toBeLessThanOrEqual(
          monitor.bounds.x + monitor.bounds.width,
        );
        expect(
          monitor.workArea.y + monitor.workArea.height,
        ).toBeLessThanOrEqual(monitor.bounds.y + monitor.bounds.height);
        expect(monitor.scaleFactor).toBe(monitor.dpi / 96);
      }
      const farthest = monitorServices.nearestPoint({
        x: -2147483648,
        y: -2147483648,
      });
      expect(monitors.some((monitor) => monitor.id === farthest.id)).toBe(true);
      const cursor = Buffer.alloc(8);
      expect(user.symbols.GetCursorPos(ptr(cursor))).not.toBe(0);
      const cursorPosition = monitorServices.cursor();
      expect(
        Number.isInteger(cursorPosition.x) &&
          Number.isInteger(cursorPosition.y),
      ).toBe(true);
      hwnd = native.create(
        "Monitor query regression",
        600,
        450,
        () => {},
        false,
      );
      native.observe(hwnd, "main", () => {});
      const before = native.getSnapshot(hwnd);
      const monitor = windowMonitor(hwnd);
      const info = Buffer.alloc(104);
      info.writeUInt32LE(104);
      const handle = user.symbols.MonitorFromWindow(hwnd, 2);
      expect(user.symbols.GetMonitorInfoW(handle, ptr(info))).not.toBe(0);
      expect(monitor.id).toBe(
        info.toString("utf16le", 40, 104).split("\0", 1)[0] ?? "",
      );
      expect(monitor.bounds).toEqual({
        x: info.readInt32LE(4),
        y: info.readInt32LE(8),
        width: info.readInt32LE(12) - info.readInt32LE(4),
        height: info.readInt32LE(16) - info.readInt32LE(8),
      });
      expect(native.getSnapshot(hwnd)).toEqual(before);
      native.minimize(hwnd);
      expect(windowMonitor(hwnd).id).toBe(monitor.id);
      expect(native.isMinimized(hwnd)).toBe(true);
      for (let index = 0; index < 20; index++) {
        expect(monitorServices.list().map((entry) => entry.id)).toEqual(
          monitors.map((entry) => entry.id),
        );
      }
    } finally {
      if (hwnd) {
        native.destroy(hwnd);
      }
      native.dispose();
    }
  },
);
