import { dlopen, ptr } from "bun:ffi";
import { expect, test } from "bun:test";
import type { NativeTrayEvent } from "@bunaway/plugin-api/native";
import { trayIco, trayPngIco } from "../fixtures/tray-icon.ts";

test.skipIf(process.platform !== "win32")(
  "actual tray tooltip/ICO updates, mouse defaults and Explorer re-registration preserve ownership",
  async () => {
    const { Windows } = await import("#native/windows/bun/win32");
    const { Tray } = await import("#native/windows/bun/tray");
    const windows = new Windows(() => {});
    const actions: string[] = [];
    const events: NativeTrayEvent[] = [];
    const tray = new Tray(
      windows,
      "Initial",
      (action) => actions.push(action),
      (event) => events.push(event),
    );
    const native = dlopen("user32.dll", {
      PostMessageW: {
        args: [
          "u64",
          "u32",
          "u64",
          "i64",
        ],
        returns: "i32",
      },
      IsWindow: {
        args: [
          "u64",
        ],
        returns: "i32",
      },
      IsWindowVisible: {
        args: [
          "u64",
        ],
        returns: "i32",
      },
      RegisterWindowMessageW: {
        args: [
          "ptr",
        ],
        returns: "u32",
      },
      GetGuiResources: {
        args: [
          "u64",
          "u32",
        ],
        returns: "u32",
      },
    });
    const kernel = dlopen("kernel32.dll", {
      GetCurrentProcess: {
        args: [],
        returns: "u64",
      },
    });
    const shell = dlopen("shell32.dll", {
      Shell_NotifyIconW: {
        args: [
          "u32",
          "ptr",
        ],
        returns: "i32",
      },
    });
    const emit = (message: number) => {
      expect(
        native.symbols.PostMessageW(tray.hwnd, 0x8001, 1n, BigInt(message)),
      ).not.toBe(0);
      windows.pump();
    };
    try {
      expect(native.symbols.IsWindowVisible(tray.hwnd)).toBe(0);
      tray.setTooltip("한글 😀 changed");
      expect(tray.get().tooltip).toBe("한글 😀 changed");
      expect(() => tray.setTooltip("😀".repeat(64))).toThrow();
      expect(tray.get().tooltip).toBe("한글 😀 changed");
      const processHandle = kernel.symbols.GetCurrentProcess();
      const before = native.symbols.GetGuiResources(processHandle, 1); // GR_USEROBJECTS includes HICON resources.
      const ico = trayIco().toString("base64");
      for (let count = 0; count < 8; count++) {
        tray.setIcon(ico);
        tray.setIcon(null);
      }
      const after = native.symbols.GetGuiResources(processHandle, 1);
      expect(after).toBeLessThanOrEqual(before);
      tray.setIcon(ico);
      expect(tray.get().icon).toBe("custom");
      tray.setIcon(trayPngIco().toString("base64"));
      expect(tray.get().icon).toBe("custom");
      const malformed = Buffer.from(trayIco());
      malformed.writeUInt32LE(0xffffffff, 18);
      expect(() => tray.setIcon(malformed.toString("base64"))).toThrow();
      expect(tray.get().icon).toBe("custom");
      tray.setClickBehavior(false, false);
      for (const message of [
        0x201,
        0x202,
        0x203,
        0x204,
        0x205,
        0x206,
        0x207,
        0x208,
        0x209,
        0x7b,
      ]) {
        emit(message);
      }
      expect(actions).toEqual([]);
      expect(
        events.map(({ button, state }) => ({
          button,
          state,
        })),
      ).toEqual([
        {
          button: "left",
          state: "down",
        },
        {
          button: "left",
          state: "up",
        },
        {
          button: "left",
          state: "double-click",
        },
        {
          button: "right",
          state: "down",
        },
        {
          button: "right",
          state: "up",
        },
        {
          button: "right",
          state: "double-click",
        },
        {
          button: "middle",
          state: "down",
        },
        {
          button: "middle",
          state: "up",
        },
        {
          button: "middle",
          state: "double-click",
        },
        {
          button: "none",
          state: "context-menu",
        },
      ]);
      tray.setClickBehavior(true, false);
      emit(0x202);
      expect(actions).toEqual([
        "show",
      ]);
      const messageName = Buffer.from("TaskbarCreated\0", "utf16le");
      const taskbarCreated = native.symbols.RegisterWindowMessageW(
        ptr(messageName),
      );
      expect(taskbarCreated).not.toBe(0);
      // Simulate Explorer losing this icon before delivering its recovery notification.
      const removed = Buffer.alloc(976);
      removed.writeUInt32LE(976, 0);
      removed.writeBigUInt64LE(tray.hwnd, 8);
      removed.writeUInt32LE(1, 16);
      expect(shell.symbols.Shell_NotifyIconW(2, ptr(removed))).not.toBe(0);
      expect(
        native.symbols.PostMessageW(tray.hwnd, taskbarCreated, 0n, 0n),
      ).not.toBe(0);
      windows.pump();
      expect(tray.get()).toMatchObject({
        tooltip: "한글 😀 changed",
        icon: "custom",
        showOnLeftClick: true,
        menuOnRightClick: false,
      });
      const bounds = tray.getBounds();
      if (bounds !== null) {
        expect(bounds.width).toBeGreaterThan(0);
        expect(bounds.height).toBeGreaterThan(0);
      }
      expect(typeof tray.focus()).toBe("boolean");
      tray.dispose();
      tray.dispose();
      expect(native.symbols.IsWindow(tray.hwnd)).toBe(0);
    } finally {
      try {
        tray.dispose();
      } finally {
        windows.dispose();
        native.close();
        kernel.close();
        shell.close();
      }
    }
  },
);
