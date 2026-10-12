import { dlopen, ptr } from "bun:ffi";
import { expect, test } from "bun:test";
import type { NativeShortcutServices } from "@bunaway/plugin-api/native";
import type { JsonValue } from "@bunaway/protocol";
import {
  hotkeyCodes,
  shortcutSchema,
} from "#plugins/global-shortcut/src/contract";
import { createShortcutOperations } from "#plugins/global-shortcut/src/shortcut-adapter";

test.skipIf(process.platform !== "win32")(
  "actual Windows registration, OS input, conflict rollback, suspension and cleanup",
  async () => {
    const { Windows } = await import("#native/windows/bun/win32");
    const { Win32Shortcuts } = await import(
      "#plugins/global-shortcut/src/win32"
    );
    const windows = new Windows(() => {});
    const native = dlopen("user32.dll", {
      RegisterHotKey: {
        args: [
          "u64",
          "i32",
          "u32",
          "u32",
        ],
        returns: "i32",
      },
      UnregisterHotKey: {
        args: [
          "u64",
          "i32",
        ],
        returns: "i32",
      },
      SendInput: {
        args: [
          "u32",
          "ptr",
          "i32",
        ],
        returns: "u32",
      },
      IsWindowVisible: {
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
    });
    const owned: bigint[] = [];
    const services: NativeShortcutServices = {
      createWindow(receive) {
        const hwnd = windows.create(
          "Shortcut regression",
          200,
          200,
          receive,
          false,
        );
        owned.push(hwnd);
        return hwnd;
      },
      destroyWindow(hwnd) {
        windows.destroy(hwnd);
      },
      emit() {},
    };
    const events: JsonValue[] = [];
    const driver = new Win32Shortcuts(services);
    const adapter = createShortcutOperations(driver, (event, payload) => {
      expect(event).toBe("globalShortcut.pressed");
      events.push(payload);
    });
    const invoke = async (operation: string, input: JsonValue) => {
      if (!adapter.executeUI) {
        throw new Error("Missing UI adapter");
      }
      return adapter.executeUI(
        `globalShortcut.${operation}`,
        input,
        "backend",
        {
          requestId: "test",
          permissions: {
            permissions: [
              `globalShortcut.${operation}`,
            ],
          },
        },
      );
    };
    const shortcut = shortcutSchema.parse({
      key: "F24",
      modifiers: [
        "Control",
        "Alt",
        "Shift",
      ],
    });
    const other = shortcutSchema.parse({
      key: "F23",
      modifiers: [
        "Control",
        "Alt",
        "Shift",
      ],
    });
    const competing = windows.create(
      "Competing shortcut",
      200,
      200,
      () => {},
      false,
    );
    const codes = hotkeyCodes(shortcut);
    let competitorRegistered = false;
    // INPUT and KEYBDINPUT use Win64 alignment. Every pressed key is released in the same batch.
    const press = () => {
      const keys = [
        0x11,
        0x12,
        0x10,
        codes.key,
      ];
      const transitions = [
        ...keys.map((key) => ({
          key,
          up: false,
        })),
        ...[
          ...keys,
        ]
          .reverse()
          .map((key) => ({
            key,
            up: true,
          })),
      ];
      const input = Buffer.alloc(40 * transitions.length);
      for (let index = 0; index < transitions.length; index++) {
        const transition = transitions[index];
        if (!transition) {
          throw new Error("Missing key transition");
        }
        input.writeUInt32LE(1, 40 * index);
        input.writeUInt16LE(transition.key, 40 * index + 8);
        input.writeUInt32LE(transition.up ? 2 : 0, 40 * index + 12);
      }
      expect(native.symbols.SendInput(transitions.length, ptr(input), 40)).toBe(
        transitions.length,
      );
    };
    const pumpUntil = async (condition: () => boolean) => {
      const deadline = Date.now() + 3000;
      while (!condition()) {
        windows.pump();
        if (Date.now() > deadline) {
          throw new Error("Global shortcut input timed out.");
        }
        await Bun.sleep(5);
      }
    };
    try {
      await invoke("register", shortcut);
      const hwnd = owned[0];
      if (!hwnd) {
        throw new Error("Message window was not created");
      }
      expect(native.symbols.IsWindowVisible(hwnd)).toBe(0);
      expect(
        native.symbols.RegisterHotKey(competing, 1, codes.modifiers, codes.key),
      ).toBe(0);
      press();
      await pumpUntil(() => events.length === 1);
      expect(events[0]).toEqual({
        shortcut,
      });
      await invoke("setSuspended", {
        suspended: true,
      });
      expect(await invoke("isRegistered", shortcut)).toBe(true);
      competitorRegistered =
        native.symbols.RegisterHotKey(
          competing,
          1,
          codes.modifiers,
          codes.key,
        ) !== 0;
      expect(competitorRegistered).toBe(true);
      press();
      for (let count = 0; count < 20; count++) {
        windows.pump();
        await Bun.sleep(5);
      }
      expect(events).toHaveLength(1);
      await expect(
        invoke("setSuspended", {
          suspended: false,
        }),
      ).rejects.toMatchObject({
        code: "BUSY",
      });
      expect(await invoke("isSuspended", null)).toBe(true);
      expect(native.symbols.UnregisterHotKey(competing, 1)).not.toBe(0);
      competitorRegistered = false;
      await invoke("setSuspended", {
        suspended: false,
      });
      await invoke("setSuspended", {
        suspended: false,
      });
      press();
      await pumpUntil(() => events.length === 2);
      await invoke("unregisterAll", null);
      competitorRegistered =
        native.symbols.RegisterHotKey(
          competing,
          1,
          codes.modifiers,
          codes.key,
        ) !== 0;
      expect(competitorRegistered).toBe(true);
      await expect(
        invoke("registerMany", {
          shortcuts: [
            other,
            shortcut,
          ],
        }),
      ).rejects.toMatchObject({
        code: "BUSY",
      });
      expect(await invoke("list", null)).toEqual([]);
      // The first key in the rejected batch is no longer reserved by our hidden window.
      const otherCodes = hotkeyCodes(other);
      expect(
        native.symbols.RegisterHotKey(
          competing,
          2,
          otherCodes.modifiers,
          otherCodes.key,
        ),
      ).not.toBe(0);
      expect(native.symbols.UnregisterHotKey(competing, 2)).not.toBe(0);
      expect(native.symbols.UnregisterHotKey(competing, 1)).not.toBe(0);
      competitorRegistered = false;
      await invoke("register", shortcut);
      adapter.dispose();
      expect(native.symbols.IsWindow(hwnd)).toBe(0);
      competitorRegistered =
        native.symbols.RegisterHotKey(
          competing,
          1,
          codes.modifiers,
          codes.key,
        ) !== 0;
      expect(competitorRegistered).toBe(true);
      adapter.dispose();
    } finally {
      if (competitorRegistered) {
        native.symbols.UnregisterHotKey(competing, 1);
      }
      try {
        adapter.dispose();
      } finally {
        windows.destroy(competing);
        windows.dispose();
        native.close();
      }
    }
  },
  15000,
);
