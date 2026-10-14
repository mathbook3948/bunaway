import { nativeFactory } from "../fixtures/native-platform.ts";
import { expect, test } from "bun:test";
import { appearanceOperations } from "#plugins/appearance/src/operations";

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
