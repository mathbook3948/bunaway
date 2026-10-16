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
      native.show(hwnd, false);
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
