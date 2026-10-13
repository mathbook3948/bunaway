import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import type {
  NativeWindowServices,
  WindowSnapshot,
} from "@bunaway/plugin-api/native";
import { createOperations } from "#plugins/windows/src/platforms/windows";
import { windowPermissions } from "../fixtures/window-permissions.ts";

const SW_HIDE = 0;
const SW_SHOW = 5;
const SW_MINIMIZE = 6;
const SW_MAXIMIZE = 3;
const SW_RESTORE = 9;
const WM_DPICHANGED = 0x02e0;
const GWL_STYLE = -16;
const WINDOWPLACEMENT_SIZE = 44;
const MAX_STATE_CHECKPOINTS = 8;
const MAX_STATE_MESSAGES = 32;
const STATE_MESSAGES = new Map([
  [
    0x0005,
    "WM_SIZE",
  ],
  [
    0x0006,
    "WM_ACTIVATE",
  ],
  [
    0x0018,
    "WM_SHOWWINDOW",
  ],
  [
    0x0046,
    "WM_WINDOWPOSCHANGING",
  ],
  [
    0x0047,
    "WM_WINDOWPOSCHANGED",
  ],
  [
    0x007d,
    "WM_STYLECHANGED",
  ],
  [
    0x0112,
    "WM_SYSCOMMAND",
  ],
]);

test.skipIf(process.platform !== "win32")(
  "real Win32 geometry queries and setters preserve state, screen origins, restoration and DPI",
  async () => {
    if (process.env.BUNAWAY_TEST_GEOMETRY_CHILD !== "1") {
      // Win32 show state depends on process/thread setup. Three fresh native runs pass,
      // while preceding full-suite tests alter raw ShowWindow behavior on the same thread.
      // Keep every native assertion below in an owned process, without pumping or repairing state.
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "test",
          import.meta.path,
        ],
        {
          env: {
            ...process.env,
            BUNAWAY_TEST_GEOMETRY_CHILD: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
          killSignal: "SIGKILL",
        },
      );
      const [output, errors, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, `${output}\n${errors}`).toBe(0);
      return;
    }
    const [{ Windows }, { user, kernel }, { dlopen, ptr }] = await Promise.all([
      import("#native/windows/bun/win32"),
      import("#native/windows/bun/win32-bindings"),
      import("bun:ffi"),
    ]);
    const messaging = dlopen("user32.dll", {
      GetWindowThreadProcessId: {
        args: [
          "u64",
          "ptr",
        ],
        returns: "u32",
      },
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
    let nativePhase = "create";
    const nativeMessages: {
      phase: string;
      message: string;
      wparam: string;
    }[] = [];
    const stateCheckpoints: unknown[] = [];
    /** Read native ownership and placement at the failing transition, without pumping or repairing state. */
    function verifyShowState(phase: string, command: number, visible: boolean) {
      const placement = Buffer.alloc(WINDOWPLACEMENT_SIZE);
      placement.writeUInt32LE(WINDOWPLACEMENT_SIZE);
      assert(user.symbols.GetWindowPlacement(hwnd, ptr(placement)));
      const processId = new Uint32Array(1);
      const ownerThread = messaging.symbols.GetWindowThreadProcessId(
        hwnd,
        ptr(processId),
      );
      const current = {
        phase,
        command,
        expectedVisible: visible,
        hwnd: hwnd.toString(),
        ownerProcess: processId[0],
        ownerThread,
        currentThread: kernel.symbols.GetCurrentThreadId(),
        foreground: user.symbols.GetForegroundWindow().toString(),
        style: user.symbols.GetWindowLongPtrW(hwnd, GWL_STYLE).toString(16),
        showCmd: placement.readUInt32LE(8),
        flags: placement.readUInt32LE(4),
        normal: Array.from(
          new Int32Array(placement.buffer, placement.byteOffset + 28, 4),
        ),
        visible: !!user.symbols.IsWindowVisible(hwnd),
        minimized: !!user.symbols.IsIconic(hwnd),
        maximized: !!user.symbols.IsZoomed(hwnd),
        fullscreen: native.isFullscreen(hwnd),
        callbackFailure:
          native.failure instanceof Error
            ? native.failure.stack
            : String(native.failure),
        messages: nativeMessages.slice(),
      };
      stateCheckpoints.push(current);
      if (stateCheckpoints.length > MAX_STATE_CHECKPOINTS) {
        stateCheckpoints.shift();
      }
      const diagnostic = JSON.stringify(stateCheckpoints);
      assert.equal(current.ownerProcess, process.pid, diagnostic);
      assert.equal(ownerThread, native.thread, diagnostic);
      assert.equal(current.currentThread, native.thread, diagnostic);
      assert.equal(native.failure, undefined, diagnostic);
      assert.equal(current.minimized, command === SW_MINIMIZE, diagnostic);
      assert.equal(current.maximized, command === SW_MAXIMIZE, diagnostic);
      assert.equal(current.visible, visible, diagnostic);
    }
    try {
      hwnd = native.create(
        "Window geometry regression",
        600,
        450,
        (message, wparam) => {
          const name = STATE_MESSAGES.get(message);
          if (!name) {
            return;
          }
          // Copy scalar message data only. No borrowed callback pointers or native queries escape.
          nativeMessages.push({
            phase: nativePhase,
            message: name,
            wparam: wparam.toString(),
          });
          if (nativeMessages.length > MAX_STATE_MESSAGES) {
            nativeMessages.shift();
          }
        },
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
          getReadiness() {
            throw new Error("Readiness is not used in this geometry test.");
          },
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
            ...windowPermissions(),
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
          nativePhase = "normal-before-geometry-state";
          native.unmaximize(hwnd);
          verifyShowState("after-unmaximize", SW_SHOW, true);
          nativePhase = "ShowWindow-before-geometry";
          user.symbols.ShowWindow(hwnd, command);
          verifyShowState("immediately-after-ShowWindow", command, true);
          nativePhase = visible
            ? "show-before-geometry"
            : "hide-before-geometry";
          native.show(hwnd, visible);
          verifyShowState("immediately-after-show-or-hide", command, visible);
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
          verifyShowState("after-setContentBounds", command, visible);
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
      nativePhase = "minimize-maximized-before-geometry";
      native.minimize(hwnd);
      verifyShowState(
        "immediately-after-minimize-maximized",
        SW_MINIMIZE,
        true,
      );
      await invoke("windows.setContentBounds", {
        x: 100,
        y: 110,
        width: 680,
        height: 490,
        unit: "logical",
      });
      verifyShowState("after-minimized-setContentBounds", SW_MINIMIZE, true);
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

      let previousPlacement: unknown;
      async function verifyNormal(
        phase: string,
        command: number,
        visible: boolean,
      ) {
        const placement = Buffer.alloc(44);
        placement.writeUInt32LE(44);
        assert(user.symbols.GetWindowPlacement(hwnd, ptr(placement)));
        const current = {
          phase,
          command,
          visible,
          showCmd: placement.readUInt32LE(8),
          flags: placement.readUInt32LE(4),
          normal: Array.from(
            new Int32Array(placement.buffer, placement.byteOffset + 28, 4),
          ),
          visibleNow: !!user.symbols.IsWindowVisible(hwnd),
          minimized: !!user.symbols.IsIconic(hwnd),
          maximized: !!user.symbols.IsZoomed(hwnd),
        };
        assert.deepEqual(
          await invoke("windows.getNormalBounds"),
          normal,
          JSON.stringify({
            previousPlacement,
            current,
          }),
        );
        previousPlacement = current;
      }

      for (const command of [
        SW_SHOW,
        SW_MINIMIZE,
        SW_MAXIMIZE,
      ]) {
        user.symbols.ShowWindow(hwnd, SW_RESTORE);
        nativePhase = "ShowWindow-before-fullscreen";
        user.symbols.ShowWindow(hwnd, command);
        verifyShowState(
          "immediately-after-ShowWindow-before-fullscreen",
          command,
          true,
        );
        for (const visible of [
          true,
          false,
        ]) {
          if (!visible) {
            nativePhase = "hide-before-fullscreen";
            user.symbols.ShowWindow(hwnd, SW_HIDE);
            verifyShowState(
              "immediately-after-hide-before-fullscreen",
              command,
              false,
            );
          }
          verifyCurrent();
          await verifyNormal("before-enter", command, visible);
          nativePhase = "enter-fullscreen";
          native.setFullscreen(hwnd, true);
          verifyCurrent();
          await verifyNormal("fullscreen", command, visible);
          nativePhase = "exit-fullscreen";
          native.setFullscreen(hwnd, false);
          // Check restoration before a subsequent hide can obscure its first failure.
          verifyShowState(
            "immediately-after-exit-fullscreen",
            command,
            visible,
          );
          verifyCurrent();
          await verifyNormal("after-exit", command, visible);
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
      nativePhase = "restore-before-constrained-fullscreen";
      user.symbols.ShowWindow(hwnd, SW_RESTORE);
      verifyShowState(
        "after-restore-before-constrained-fullscreen",
        SW_RESTORE,
        true,
      );
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

      nativePhase = "hide-before-constrained-fullscreen";
      native.show(hwnd, false);
      verifyShowState(
        "after-hide-before-constrained-fullscreen",
        SW_SHOW,
        false,
      );
      nativePhase = "enter-constrained-fullscreen";
      native.setFullscreen(hwnd, true);
      verifyShowState("after-enter-constrained-fullscreen", SW_SHOW, false);
      await invoke("windows.setSizeConstraints", {
        minWidth: 700,
        maxHeight: 450,
      });
      verifyShowState("after-fullscreen-constraints", SW_SHOW, false);
      const fullscreenNormal = native.getBounds(hwnd, "normal");
      nativePhase = "exit-constrained-fullscreen";
      native.setFullscreen(hwnd, false);
      verifyShowState("after-exit-constrained-fullscreen", SW_SHOW, false);
      try {
        expect(native.getBounds(hwnd, "outer")).toEqual(fullscreenNormal);
      } catch (error) {
        console.error(
          "Constrained fullscreen bounds mismatch",
          JSON.stringify({
            expected: fullscreenNormal,
            stateCheckpoints,
          }),
        );
        throw error;
      }
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
  15_000,
);
