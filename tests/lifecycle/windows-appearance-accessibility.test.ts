import { expect, test } from "bun:test";
import { windowsAppearanceOperations } from "#plugins/appearance/src/operations";
import { nativeFactory } from "../fixtures/native-platform.ts";

test.skipIf(process.platform !== "win32")(
  "real Windows accessibility state reads the setting flag and UI Automation probe, then rejects use after disposal",
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
    });
    const operations = createOperations({
      dataRoot: ".",
      capabilities: [],
    });
    try {
      const read = async () =>
        windowsAppearanceOperations.getAccessibilityState.output.parse(
          await operations.execute(
            "appearance.getAccessibilityState",
            null,
            "backend",
          ),
        );
      const flag = Buffer.alloc(4);
      expect(
        driver.symbols.SystemParametersInfoW(0x46, 0, ptr(flag), 0),
      ).not.toBe(0);
      const first = await read();
      expect(first.screenReaderEnabled).toBe(flag.readUInt32LE() !== 0);
      // A CI runner usually has no UI Automation client, so only the type is fixed.
      expect(typeof first.assistiveTechnologyActive).toBe("boolean");
      // The lazily loaded probe stays usable across calls.
      for (let index = 0; index < 5; index++) {
        expect(typeof (await read()).assistiveTechnologyActive).toBe("boolean");
      }
      const preferences = (await operations.execute(
        "appearance.getPreferences",
        null,
        "backend",
      )) as {
        screenReaderEnabled: boolean;
      };
      expect(typeof preferences.screenReaderEnabled).toBe("boolean");
      await expect(
        operations.execute(
          "appearance.getAccessibilityState",
          null,
          "untrusted-view",
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "PERMISSION_DENIED",
        }),
      );
      await expect(
        operations.execute("appearance.getAccessibilityState", {}, "backend"),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
        }),
      );
      await operations.dispose();
      await operations.dispose();
      await expect(
        operations.execute("appearance.getAccessibilityState", null, "backend"),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "CANCELLED",
        }),
      );
    } finally {
      await operations.dispose();
      driver.close();
    }
  },
);
