import { expect, test } from "bun:test";
import assert from "node:assert/strict";

test.skipIf(process.platform !== "win32")(
  "native window state restores maximize history, shows hidden windows and retains constraints and fullscreen placement",
  async () => {
    const [{ Windows }, { user, withBuffer }] = await Promise.all([
      import("#native/windows/bun/win32"),
      import("#native/windows/bun/win32-bindings"),
    ]);
    const windows = new Windows(() => {});
    let hwnd = 0n;
    try {
      hwnd = windows.create(
        "Window state regression",
        650,
        550,
        () => {},
        false,
        {
          minWidth: 600,
          minHeight: 500,
          maxWidth: 800,
          maxHeight: 700,
        },
      );
      expect(windows.isVisible(hwnd)).toBe(false);
      expect(windows.isMinimized(hwnd)).toBe(false);
      expect(windows.isMaximized(hwnd)).toBe(false);
      expect(windows.isFullscreen(hwnd)).toBe(false);
      expect(windows.isFocused(hwnd)).toBe(false);

      const checkNativeState = () => {
        expect(windows.isMinimized(hwnd)).toBe(!!user.symbols.IsIconic(hwnd));
        expect(windows.isMaximized(hwnd)).toBe(!!user.symbols.IsZoomed(hwnd));
        expect(windows.isVisible(hwnd)).toBe(
          !!user.symbols.IsWindowVisible(hwnd),
        );
        expect(windows.isFocused(hwnd)).toBe(
          user.symbols.GetForegroundWindow() === hwnd,
        );
      };
      const checkClientBounds = () => {
        const rect = Buffer.alloc(16);
        assert(
          withBuffer(rect, (address) =>
            user.symbols.GetClientRect(hwnd, address),
          ),
        );
        const dpi = user.symbols.GetDpiForWindow(hwnd);
        const width = Math.round((rect.readInt32LE(8) * 96) / dpi);
        const height = Math.round((rect.readInt32LE(12) * 96) / dpi);
        expect(width).toBeGreaterThanOrEqual(600);
        expect(width).toBeLessThanOrEqual(800);
        expect(height).toBeGreaterThanOrEqual(500);
        expect(height).toBeLessThanOrEqual(700);
      };
      windows.maximize(hwnd);
      expect(windows.isMaximized(hwnd)).toBe(true);
      checkClientBounds();
      windows.minimize(hwnd);
      expect(windows.isMinimized(hwnd)).toBe(true);
      expect(windows.isVisible(hwnd)).toBe(true);
      windows.minimize(hwnd);
      windows.show(hwnd, false);
      windows.restore(hwnd);
      expect(windows.isMaximized(hwnd)).toBe(true);
      expect(windows.isVisible(hwnd)).toBe(true);
      windows.maximize(hwnd);
      checkClientBounds();
      windows.minimize(hwnd);
      windows.unmaximize(hwnd);
      expect(windows.isMinimized(hwnd)).toBe(false);
      expect(windows.isMaximized(hwnd)).toBe(false);
      windows.minimize(hwnd);
      windows.toggleMaximize(hwnd);
      expect(windows.isMinimized(hwnd)).toBe(false);
      expect(windows.isMaximized(hwnd)).toBe(true);
      windows.unmaximize(hwnd);
      checkClientBounds();
      windows.minimize(hwnd);
      windows.restore(hwnd);
      expect(windows.isMaximized(hwnd)).toBe(false);
      windows.maximize(hwnd);
      windows.restore(hwnd);
      expect(windows.isMaximized(hwnd)).toBe(false);
      windows.toggleMaximize(hwnd);
      expect(windows.isMaximized(hwnd)).toBe(true);
      windows.toggleMaximize(hwnd);
      expect(windows.isMaximized(hwnd)).toBe(false);

      // Queries must also observe transitions performed outside the plugin.
      user.symbols.ShowWindow(hwnd, 3);
      expect(windows.isMaximized(hwnd)).toBe(true);
      user.symbols.ShowWindow(hwnd, 6);
      expect(windows.isMinimized(hwnd)).toBe(true);
      windows.restore(hwnd);
      expect(windows.isMaximized(hwnd)).toBe(true);

      for (const action of [
        "minimize",
        "maximize",
        "unmaximize",
        "restore",
        "toggleMaximize",
      ] as const) {
        windows.unmaximize(hwnd);
        windows.show(hwnd, false);
        windows[action](hwnd);
        expect(windows.isVisible(hwnd)).toBe(true);
        checkNativeState();
        windows.unmaximize(hwnd);
      }
      for (const maximized of [
        false,
        true,
      ]) {
        if (maximized) {
          windows.maximize(hwnd);
        }
        windows.show(hwnd, false);
        windows.setFullscreen(hwnd, true);
        expect(windows.isFullscreen(hwnd)).toBe(true);
        for (const action of [
          "minimize",
          "maximize",
          "unmaximize",
          "restore",
          "toggleMaximize",
        ] as const) {
          expect(() => windows[action](hwnd)).toThrow("Exit fullscreen");
          expect(windows.isFullscreen(hwnd)).toBe(true);
          expect(windows.isVisible(hwnd)).toBe(false);
        }
        windows.setFullscreen(hwnd, false);
        expect(windows.isFullscreen(hwnd)).toBe(false);
        expect(windows.isVisible(hwnd)).toBe(false);
        expect(windows.isMaximized(hwnd)).toBe(maximized);
        windows.restore(hwnd);
        checkClientBounds();
      }
      windows.destroy(hwnd);
      const destroyed = hwnd;
      hwnd = 0n;
      for (const query of [
        "isMinimized",
        "isMaximized",
        "isFullscreen",
        "isVisible",
        "isFocused",
      ] as const) {
        expect(() => windows[query](destroyed)).toThrow(
          "Window is no longer valid",
        );
      }
    } finally {
      if (hwnd) {
        windows.destroy(hwnd);
      }
      windows.dispose();
    }
  },
);
