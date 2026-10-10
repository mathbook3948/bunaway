import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import type {
  NativeWindowServices,
  WindowSnapshot,
} from "@bunaway/plugin-api/native";
import { createOperations } from "#plugins/windows/src/windows";

const SW_HIDE = 0;
const SW_SHOW = 5;
const SW_MINIMIZE = 6;
const SW_MAXIMIZE = 3;
const SW_RESTORE = 9;
const WM_DPICHANGED = 0x02e0;

test.skipIf(process.platform !== "win32")(
  "real Win32 geometry queries and setters preserve state, screen origins, restoration and DPI",
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
          getSnapshot: () => native.getSnapshot(hwnd),
          show: (visible) => native.show(hwnd, visible),
          showInactive: () => native.showInactive(hwnd),
          activate: () => native.activate(hwnd),
          focus: () => native.focus(hwnd),
          close: () => true,
          minimize: () => native.minimize(hwnd),
          maximize: () => native.maximize(hwnd),
          unmaximize: () => native.unmaximize(hwnd),
          restore: () => native.restore(hwnd),
          toggleMaximize: () => native.toggleMaximize(hwnd),
          isMinimized: () => native.isMinimized(hwnd),
          isMaximized: () => native.isMaximized(hwnd),
          isVisible: () => native.isVisible(hwnd),
          isFocused: () => native.isFocused(hwnd),
          isFullscreen: () => native.isFullscreen(hwnd),
          getBounds: (area) => native.getBounds(hwnd, area),
          getDpi: () => native.getDpi(hwnd),
          getSizeConstraints: () => native.getSizeConstraints(hwnd),
          setSizeConstraints: (value) => native.setSizeConstraints(hwnd, value),
          setSize: (width, height) => native.setSize(hwnd, width, height),
          setPosition: (x, y) => native.setPosition(hwnd, x, y),
          setGeometry: (area, geometry) =>
            native.setGeometry(hwnd, area, geometry),
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
      const events: WindowSnapshot[] = [];
      native.observe(hwnd, "main", (snapshot) => events.push(snapshot));
      // A bounds request commits a single combined move/resize and retains visibility.
      for (const visible of [
        false,
        true,
      ]) {
        native.show(hwnd, visible);
        const start = events.length;
        await invoke("windows.setContentBounds", {
          x: -31,
          y: 73,
          width: 650,
          height: 470,
          unit: "logical",
        });
        const actual = native.getBounds(hwnd, "content");
        const dpi = actual.dpi;
        expect(actual).toEqual({
          x: Math.round((-31 * dpi) / 96),
          y: Math.round((73 * dpi) / 96),
          width: Math.round((650 * dpi) / 96),
          height: Math.round((470 * dpi) / 96),
          dpi,
        });
        expect(native.isVisible(hwnd)).toBe(visible);
        expect(events.length - start).toBe(visible ? 0 : 1);
        expect(events.at(-1)).toEqual(native.getSnapshot(hwnd));
        expect(native.getSnapshot(hwnd).bounds).toEqual(
          native.getBounds(hwnd, "outer"),
        );
        await invoke("windows.setContentPosition", {
          x: -42,
          y: 85,
        });
        expect(await invoke("windows.getContentPosition")).toEqual({
          x: -42,
          y: 85,
          dpi,
        });
        const outer = native.getBounds(hwnd, "outer");
        await invoke("windows.setOuterSize", {
          width: outer.width + 11,
          height: outer.height + 7,
        });
        expect(native.getBounds(hwnd, "outer")).toEqual({
          ...outer,
          width: outer.width + 11,
          height: outer.height + 7,
        });
        // Put both passes at the same final content bounds before the next visibility transition.
        await invoke("windows.setContentBounds", {
          x: -31,
          y: 73,
          width: 650,
          height: 470,
          unit: "logical",
        });
      }
      await invoke("windows.setSizeConstraints", {
        minWidth: 700,
        maxHeight: 450,
      });
      await invoke("windows.setContentBounds", {
        x: 100,
        y: 100,
        width: 650,
        height: 470,
        unit: "logical",
      });
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
      // Restored bounds change while the current iconic/zoomed snapshot stays current.
      for (const command of [
        SW_MINIMIZE,
        SW_MAXIMIZE,
      ]) {
        for (const visible of [
          true,
          false,
        ]) {
          native.unmaximize(hwnd);
          user.symbols.ShowWindow(hwnd, command);
          native.show(hwnd, visible);
          expect(native.isMinimized(hwnd)).toBe(command === SW_MINIMIZE);
          expect(native.isMaximized(hwnd)).toBe(command === SW_MAXIMIZE);
          const state = native.getSnapshot(hwnd).state;
          const before = native.getBounds(hwnd, "outer");
          await invoke("windows.setContentBounds", {
            x: 100,
            y: 110,
            width: 680,
            height: 490,
            unit: "logical",
          });
          expect(native.getSnapshot(hwnd).state).toEqual(state);
          expect(native.getBounds(hwnd, "outer")).toEqual(before);
          const projected = native.getBounds(hwnd, "normal");
          await invoke("windows.setContentPosition", {
            x: 115,
            y: 125,
          });
          await invoke("windows.setOuterSize", {
            width: projected.width,
            height: projected.height,
          });
          expect(native.getSnapshot(hwnd).state).toEqual(state);
          await invoke("windows.setOuterBounds", {
            x: 120,
            y: 130,
            width: projected.width + 10,
            height: projected.height + 10,
          });
          const normal = native.getBounds(hwnd, "normal");
          expect(normal).toEqual({
            ...projected,
            x: 120,
            y: 130,
            width: projected.width + 10,
            height: projected.height + 10,
          });
          expect(native.getSnapshot(hwnd).state).toEqual(state);
          native.unmaximize(hwnd);
          expect(native.getBounds(hwnd, "outer")).toEqual(normal);
          expect(events.at(-1)).toEqual(native.getSnapshot(hwnd));
        }
      }
      native.maximize(hwnd);
      native.minimize(hwnd);
      await invoke("windows.setContentBounds", {
        x: 100,
        y: 110,
        width: 680,
        height: 490,
        unit: "logical",
      });
      const minimizedNormal = native.getBounds(hwnd, "normal");
      native.restore(hwnd);
      expect(native.isMaximized(hwnd)).toBe(true);
      native.unmaximize(hwnd);
      expect(native.getBounds(hwnd, "outer")).toEqual(minimizedNormal);
      native.setFullscreen(hwnd, true);
      const fullscreenSnapshot = native.getSnapshot(hwnd);
      for (const [operation, payload] of [
        [
          "windows.setContentPosition",
          {
            x: 0,
            y: 0,
          },
        ],
        [
          "windows.setOuterSize",
          {
            width: 700,
            height: 500,
          },
        ],
        [
          "windows.setContentBounds",
          {
            x: 0,
            y: 0,
            width: 700,
            height: 500,
          },
        ],
        [
          "windows.setOuterBounds",
          {
            x: 0,
            y: 0,
            width: 700,
            height: 500,
          },
        ],
      ] as const) {
        await expect(invoke(operation, payload)).rejects.toMatchObject({
          code: "INVALID_ARGUMENT",
        });
      }
      expect(native.getSnapshot(hwnd)).toEqual(fullscreenSnapshot);
      native.setFullscreen(hwnd, false);
      const beforeInvalid = native.getSnapshot(hwnd);
      for (const payload of [
        {
          x: 0,
          y: 0,
          width: 199,
          height: 500,
          unit: "logical",
        },
        {
          x: 0,
          y: 0,
          width: 4097,
          height: 500,
          unit: "logical",
        },
        {
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        },
        {
          x: 0,
          y: 0,
          width: 2147483647,
          height: 500,
        },
        {
          x: 2147483647,
          y: 0,
          width: 700,
          height: 500,
        },
        {
          x: -2147483648,
          y: 0,
          width: 700,
          height: 500,
        },
      ]) {
        await expect(
          invoke("windows.setContentBounds", payload),
        ).rejects.toMatchObject({
          code: "INVALID_ARGUMENT",
        });
        expect(native.getSnapshot(hwnd)).toEqual(beforeInvalid);
      }
      native.show(hwnd, false);
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
      await invoke("windows.setPosition", {
        x: -500,
        y: -200,
      });
      expect(native.getBounds(hwnd, "normal")).toEqual(normal);
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
        // Use odd sizes below the applied bounds, which Win32 may have capped at its
        // maximum tracking size. Unconstrained axes must avoid a logical round-trip.
        const beforeSize = native.getBounds(hwnd, "outer");
        const oddSize = {
          width: Math.floor(beforeSize.width / 2) * 2 - 1,
          height: Math.floor(beforeSize.height / 2) * 2 - 1,
        };
        await invoke("windows.setOuterSize", oddSize);
        expect(native.getBounds(hwnd, "outer")).toEqual({
          ...beforeSize,
          ...oddSize,
        });
        await invoke("windows.setContentPosition", {
          x: -1,
          y: 1,
          unit: "logical",
        });
        expect(await invoke("windows.getContentPosition")).toEqual({
          x: Math.round(-targetDpi / 96) || 0,
          y: Math.round(targetDpi / 96),
          dpi: targetDpi,
        });
        expect(events.at(-1)).toEqual(native.getSnapshot(hwnd));
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
