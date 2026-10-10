import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import type { NativeWindowServices } from "@bunaway/plugin-api/native";
import { createOperations } from "#plugins/windows/src/windows";

const SW_HIDE = 0;
const SW_SHOW = 5;
const SW_MINIMIZE = 6;
const SW_MAXIMIZE = 3;
const SW_RESTORE = 9;
const WM_DPICHANGED = 0x02e0;

test.skipIf(process.platform !== "win32")(
  "real Win32 geometry queries preserve state, screen origins, restoration and DPI",
  async () => {
    const [{ Windows }, { user }, { dlopen, ptr }] = await Promise.all([
      import("#native/windows/bun/win32"),
      import("#native/windows/bun/win32-bindings"),
      import("bun:ffi"),
    ]);
    const messaging = dlopen("user32.dll", {
      SendMessageW: {
        args: [
          "u64",
          "u32",
          "u64",
          "ptr",
        ],
        returns: "i64",
      },
    });
    const native = new Windows(() => {});
    let hwnd = 0n;
    let closed = false;
    try {
      hwnd = native.create(
        "Window geometry regression",
        600,
        450,
        () => {},
        false,
      );
      const services: NativeWindowServices = {
        specs: [
          {
            view: "main",
            title: "Geometry",
            home: "https://app.bunaway.local",
            window: {
              width: 600,
              height: 450,
            },
          },
        ],
        read: () => ({
          closed,
          cleaned: closed,
          ready: true,
          failure: null,
          deadline: Infinity,
        }),
        create() {},
        close: () => true,
        stopping: () => false,
        cancelled: () => false,
        now: Date.now,
        tick: async () => {},
        window: () => ({
          show: (visible) => native.show(hwnd, visible),
          focus: () => native.focus(hwnd),
          close: () => true,
          isFullscreen: () => native.isFullscreen(hwnd),
          getBounds: (area) => native.getBounds(hwnd, area),
          getDpi: () => native.getDpi(hwnd),
          getSizeConstraints: () => native.getSizeConstraints(hwnd),
          setSizeConstraints: (value) => native.setSizeConstraints(hwnd, value),
          setSize: (width, height) => native.setSize(hwnd, width, height),
          setPosition: (x, y) => native.setPosition(hwnd, x, y),
          setFullscreen: (value) => native.setFullscreen(hwnd, value),
          setCloseConfirmation() {},
        }),
      };
      const execute = createOperations({
        dataRoot: ".",
        capabilities: [],
        windows: services,
      }).executeUI;
      assert(execute, "Missing UI adapter");
      const context = {
        requestId: "native-geometry",
        permissions: {
          permissions: [
            {
              identifier: "windows:control",
              allow: [
                {
                  view: "main",
                },
              ],
            },
          ],
        },
      };
      const invoke = (
        operation: string,
        payload: Record<string, string | number | boolean> = {},
      ) =>
        execute(
          operation,
          {
            view: "main",
            ...payload,
          },
          "backend",
          context,
        );
      await invoke("windows.setSize", {
        width: 701,
        height: 503,
      });
      await invoke("windows.setPosition", {
        x: -123,
        y: -45,
      });
      const dpi = native.getDpi(hwnd);
      expect(
        await invoke("windows.getContentSize", {
          unit: "logical",
        }),
      ).toEqual({
        width: 701,
        height: 503,
        dpi,
      });
      expect(await invoke("windows.getOuterPosition")).toEqual({
        x: -123,
        y: -45,
        dpi,
      });
      const normal = native.getBounds(hwnd, "normal");
      expect(normal).toEqual(native.getBounds(hwnd, "outer"));

      function verifyCurrent() {
        const state = [
          user.symbols.IsWindowVisible(hwnd),
          user.symbols.IsIconic(hwnd),
          user.symbols.IsZoomed(hwnd),
          native.isFullscreen(hwnd),
        ];
        const rect = new Int32Array(4);
        assert(user.symbols.GetWindowRect(hwnd, ptr(rect)));
        const outer = native.getBounds(hwnd, "outer");
        expect(outer).toEqual({
          x: rect[0] ?? 0,
          y: rect[1] ?? 0,
          width: (rect[2] ?? 0) - (rect[0] ?? 0),
          height: (rect[3] ?? 0) - (rect[1] ?? 0),
          dpi: native.getDpi(hwnd),
        });
        const origin = new Int32Array(2);
        assert(user.symbols.ClientToScreen(hwnd, ptr(origin)));
        assert(user.symbols.GetClientRect(hwnd, ptr(rect)));
        expect(native.getBounds(hwnd, "content")).toEqual({
          x: origin[0] ?? 0,
          y: origin[1] ?? 0,
          width: rect[2] ?? 0,
          height: rect[3] ?? 0,
          dpi: native.getDpi(hwnd),
        });
        native.getBounds(hwnd, "normal");
        expect([
          user.symbols.IsWindowVisible(hwnd),
          user.symbols.IsIconic(hwnd),
          user.symbols.IsZoomed(hwnd),
          native.isFullscreen(hwnd),
        ]).toEqual(state);
        assert.equal(native.failure, undefined);
      }

      for (const command of [
        SW_SHOW,
        SW_MINIMIZE,
        SW_MAXIMIZE,
      ]) {
        user.symbols.ShowWindow(hwnd, SW_RESTORE);
        user.symbols.ShowWindow(hwnd, command);
        for (const visible of [
          true,
          false,
        ]) {
          if (!visible) {
            user.symbols.ShowWindow(hwnd, SW_HIDE);
          }
          verifyCurrent();
          expect(await invoke("windows.getNormalBounds")).toEqual(normal);
          native.setFullscreen(hwnd, true);
          verifyCurrent();
          expect(await invoke("windows.getNormalBounds")).toEqual(normal);
          native.setFullscreen(hwnd, false);
          verifyCurrent();
          expect(await invoke("windows.getNormalBounds")).toEqual(normal);
          expect(user.symbols.IsWindowVisible(hwnd)).toBe(Number(visible));
        }
      }

      // A setter in a maximized window changes its future normal size, not its show state.
      user.symbols.ShowWindow(hwnd, SW_RESTORE);
      user.symbols.ShowWindow(hwnd, SW_MAXIMIZE);
      await invoke("windows.setSize", {
        width: 650,
        height: 470,
      });
      const resizedNormal = native.getBounds(hwnd, "normal");
      expect(user.symbols.IsZoomed(hwnd)).toBe(1);
      user.symbols.ShowWindow(hwnd, SW_RESTORE);
      expect(native.getBounds(hwnd, "outer")).toEqual(resizedNormal);
      expect(
        await invoke("windows.getContentSize", {
          unit: "logical",
        }),
      ).toEqual({
        width: 650,
        height: 470,
        dpi: native.getDpi(hwnd),
      });

      native.show(hwnd, false);
      native.setFullscreen(hwnd, true);
      await invoke("windows.setSizeConstraints", {
        minWidth: 700,
        maxHeight: 450,
      });
      const fullscreenNormal = native.getBounds(hwnd, "normal");
      native.setFullscreen(hwnd, false);
      expect(native.getBounds(hwnd, "outer")).toEqual(fullscreenNormal);
      expect(user.symbols.IsWindowVisible(hwnd)).toBe(0);
      expect(
        await invoke("windows.getContentSize", {
          unit: "logical",
        }),
      ).toEqual({
        width: 700,
        height: 450,
        dpi: native.getDpi(hwnd),
      });
      await invoke("windows.setSizeConstraints");
      await invoke("windows.setSize", {
        width: 650,
        height: 470,
      });

      // Exercise real DPI message handling; this is synthetic DPI, not a physical monitor move.
      for (const targetDpi of [
        120,
        144,
        192,
      ]) {
        const frame = new Int32Array([
          0,
          0,
          Math.round((650 * targetDpi) / 96),
          Math.round((470 * targetDpi) / 96),
        ]);
        assert(
          user.symbols.AdjustWindowRectExForDpi(
            ptr(frame),
            Number(user.symbols.GetWindowLongPtrW(hwnd, -16)),
            0,
            Number(user.symbols.GetWindowLongPtrW(hwnd, -20)),
            targetDpi,
          ),
        );
        const suggested = new Int32Array([
          -200,
          -100,
          -200 + (frame[2] ?? 0) - (frame[0] ?? 0),
          -100 + (frame[3] ?? 0) - (frame[1] ?? 0),
        ]);
        messaging.symbols.SendMessageW(
          hwnd,
          WM_DPICHANGED,
          BigInt(targetDpi),
          ptr(suggested),
        );
        verifyCurrent();
        expect(await invoke("windows.getOuterPosition")).toEqual({
          x: -200,
          y: -100,
          dpi: targetDpi,
        });
        expect(
          await invoke("windows.getContentSize", {
            unit: "logical",
          }),
        ).toEqual({
          // A synthetic message updates our DPI cache, but does not change OS frame metrics.
          width: Math.round(
            (native.getBounds(hwnd, "content").width * 96) / targetDpi,
          ),
          height: Math.round(
            (native.getBounds(hwnd, "content").height * 96) / targetDpi,
          ),
          dpi: targetDpi,
        });
        expect(native.getBounds(hwnd, "normal")).toEqual(
          native.getBounds(hwnd, "outer"),
        );
      }
      closed = true;
      await expect(invoke("windows.getOuterBounds")).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    } finally {
      if (hwnd) {
        native.destroy(hwnd);
      }
      native.dispose();
      messaging.close();
    }
  },
);
