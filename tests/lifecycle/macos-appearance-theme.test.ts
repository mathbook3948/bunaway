import { expect, test } from "bun:test";
import { themeStateSchema } from "#plugins/appearance/src/contract";
import { nativeFactory } from "../fixtures/native-platform.ts";

/** Real AppKit: the app-wide theme assignment, its readback and restoration on dispose. */
test.skipIf(process.platform !== "darwin")(
  "real AppKit app theme follows setTheme, rejects window IDs and returns to the OS setting on dispose",
  async () => {
    const [{ default: nativeDefinition }, { Objc }] = await Promise.all([
      import("#plugins/appearance/src/index"),
      import("#native/macos/bun/objc"),
    ]);
    const createOperations = nativeFactory(nativeDefinition, "macos");
    const objc = new Objc();
    const adapter = createOperations({
      dataRoot: ".",
      capabilities: [],
    });
    const call = async (
      operation: string,
      payload: Record<string, string | null> | null,
    ) =>
      themeStateSchema.parse(
        await adapter.execute(`appearance.${operation}`, payload, "backend"),
      );
    // Keep borrowed Cocoa objects alive across awaited SDK calls on this thread.
    const pool = objc.object("NSAutoreleasePool");
    const app = objc.send(objc.class("NSApplication"), "sharedApplication");
    const original = objc.send(app, "appearance");
    const assigned = () => {
      const appearance = objc.send(app, "appearance");
      return appearance === null
        ? null
        : objc.text(objc.send(appearance, "name"));
    };
    try {
      expect(await call("getTheme", null)).toMatchObject({
        preference: "system",
        override: null,
      });
      for (const [theme, name] of [
        [
          "dark",
          "NSAppearanceNameDarkAqua",
        ],
        [
          "light",
          "NSAppearanceNameAqua",
        ],
      ] as const) {
        const state = await call("setTheme", {
          theme,
        });
        expect(assigned()).toBe(name);
        expect(state.preference).toBe(theme);
        expect(state.override).toBeNull();
        // Increase Contrast can resolve an explicit assignment differently, but never to null.
        expect(state.effectiveTheme).not.toBeNull();
        expect(await call("getTheme", null)).toEqual(state);
      }
      await call("setTheme", {
        theme: "dark",
      });
      await call("setTheme", {
        theme: "system",
      });
      // system clears the assignment instead of pinning the current OS appearance.
      expect(assigned()).toBeNull();
      await expect(
        adapter.execute(
          "appearance.setTheme",
          {
            windowId: "window-1",
            theme: "dark",
          },
          "backend",
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
        }),
      );
      await expect(
        adapter.execute(
          "appearance.setTheme",
          {
            theme: null,
          },
          "backend",
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
        }),
      );
      await expect(
        adapter.execute(
          "appearance.setTheme",
          {
            theme: "dark",
          },
          "untrusted-view",
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "PERMISSION_DENIED",
        }),
      );
      expect(assigned()).toBeNull();
      await call("setTheme", {
        theme: "dark",
      });
      expect(assigned()).toBe("NSAppearanceNameDarkAqua");
      await adapter.dispose();
      await adapter.dispose();
      expect(assigned()).toBeNull();
    } finally {
      await adapter.dispose();
      objc.send(app, "setAppearance:", original);
      objc.send(pool, "drain");
      objc.releaseCallbacks();
    }
  },
  30_000,
);
