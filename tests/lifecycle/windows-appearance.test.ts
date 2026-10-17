import { expect, test } from "bun:test";
import { appearanceOperations } from "#plugins/appearance/src/operations";
import {
  colorRef,
  isDarkColor,
} from "#plugins/appearance/src/platforms/windows";
import { nativeFactory } from "../fixtures/native-platform.ts";

test.skipIf(process.platform !== "win32")(
  "real Windows appearance queries match native accessibility and colors, retain DLL ownership and reject use after disposal",
  async () => {
    const [{ default: nativeDefinition }, { dlopen, ptr }] = await Promise.all([
      import("#plugins/appearance/src/index"),
      import("bun:ffi"),
    ]);
    const createOperations = nativeFactory(nativeDefinition, "windows");
    const driver = dlopen("user32.dll", {
      SystemParametersInfoW: {
        args: [
          "u32",
          "u32",
          "ptr",
          "u32",
        ],
        returns: "i32",
      },
      GetSysColor: {
        args: [
          "i32",
        ],
        returns: "u32",
      },
    });
    const first = createOperations({
      dataRoot: ".",
      capabilities: [],
    });
    const second = createOperations({
      dataRoot: ".",
      capabilities: [],
    });
    try {
      await first.dispose();
      await first.dispose();
      await expect(
        first.execute("appearance.getPreferences", null, "backend"),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "CANCELLED",
        }),
      );
      const preferences = appearanceOperations.getPreferences.output.parse(
        await second.execute("appearance.getPreferences", null, "backend"),
      );
      const info = Buffer.alloc(16);
      info.writeUInt32LE(16);
      expect(
        driver.symbols.SystemParametersInfoW(0x42, 16, ptr(info), 0),
      ).not.toBe(0);
      expect(preferences.highContrast).toBe(Boolean(info.readUInt32LE(4) & 1));
      expect(preferences.forcedColors).toBe(preferences.highContrast);
      // Without high contrast no dark high-contrast scheme applies, so a CI
      // runner with default settings reports false.
      expect(preferences.invertedColors).toBe(
        preferences.highContrast &&
          isDarkColor(colorRef(driver.symbols.GetSysColor(5))),
      );
      if (!preferences.highContrast) {
        expect(preferences.invertedColors).toBe(false);
      }
      for (const [action, actual, inverted] of [
        [
          0x1042,
          preferences.reducedMotion,
          true,
        ],
        [
          0x46,
          preferences.screenReaderEnabled,
          false,
        ],
      ] as const) {
        const value = Buffer.alloc(4);
        expect(
          driver.symbols.SystemParametersInfoW(action, 0, ptr(value), 0),
        ).not.toBe(0);
        expect(actual).toBe(
          inverted ? value.readUInt32LE() === 0 : value.readUInt32LE() !== 0,
        );
      }
      const color = driver.symbols.GetSysColor(5);
      expect(preferences.colors.window).toBe(
        `#${(color & 255).toString(16).padStart(2, "0")}${((color >>> 8) & 255).toString(16).padStart(2, "0")}${((color >>> 16) & 255).toString(16).padStart(2, "0")}`,
      );
      await expect(
        second.execute("appearance.unknown", null, "backend"),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "UNSUPPORTED",
        }),
      );
      await expect(
        second.execute("appearance.getPreferences", {}, "backend"),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
        }),
      );
      for (let index = 0; index < 10; index++) {
        expect(
          appearanceOperations.getPreferences.output.safeParse(
            await second.execute("appearance.getPreferences", null, "backend"),
          ).success,
        ).toBe(true);
      }
    } finally {
      await first.dispose();
      await second.dispose();
      driver.close();
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "real DWM frame preferences are window-local, reset on disposal and invalidate destroyed lifetimes",
  async () => {
    const [
      { Windows },
      { disposeWin32Bindings },
      { AppearanceWindows },
      { initialize },
      { createAppearanceController },
      { dlopen, ptr },
    ] = await Promise.all([
      import("#native/windows/bun/win32"),
      import("#native/windows/bun/win32-bindings"),
      import("#native/windows/bun/appearance"),
      import("#plugins/appearance/src/platforms/windows-preferences"),
      import("#plugins/appearance/src/platforms/windows-controller"),
      import("bun:ffi"),
    ]);
    const windows = new Windows(() => {});
    const driver = dlopen("dwmapi.dll", {
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
    const service = new AppearanceWindows();
    const reader = initialize();
    const controller = createAppearanceController(reader, {
      appearance: service,
    });
    const first = windows.create("Appearance first", 240, 200, () => {}, false);
    const second = windows.create(
      "Appearance second",
      240,
      200,
      () => {},
      false,
    );
    const dark = (hwnd: bigint) => {
      const value = Buffer.alloc(4);
      expect(
        driver.symbols.DwmGetWindowAttribute(hwnd, 20, ptr(value), 4),
      ).toBeGreaterThanOrEqual(0);
      return value.readInt32LE() !== 0;
    };
    try {
      service.attach("first", first);
      service.attach("second", second);
      const system = reader.read();
      expect(dark(first)).toBe(
        !system.highContrast && system.appsTheme === "dark",
      );
      controller.setTheme(null, "dark");
      expect(dark(first)).toBe(!system.highContrast);
      expect(dark(second)).toBe(!system.highContrast);
      controller.setTheme("second", "light");
      expect(dark(first)).toBe(!system.highContrast);
      expect(dark(second)).toBe(false);
      expect(windows.isVisible(first)).toBe(false);
      expect(windows.isVisible(second)).toBe(false);
      controller.setTheme("second", null);
      expect(dark(second)).toBe(!system.highContrast);
      controller.setTheme("first", "system");
      expect(dark(first)).toBe(
        !system.highContrast && system.appsTheme === "dark",
      );
      service.detach("first");
      expect(() => controller.getTheme("first")).toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
        }),
      );
      controller.dispose();
      controller.dispose();
      expect(dark(second)).toBe(false);
    } finally {
      service.detach("first");
      service.detach("second");
      controller.dispose();
      windows.destroy(first);
      windows.destroy(second);
      windows.dispose();
      driver.close();
      disposeWin32Bindings();
    }
  },
);
