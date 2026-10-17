import { dlopen } from "bun:ffi";
import { windowPermissions } from "../fixtures/window-permissions.ts";
import { expect, test } from "bun:test";
import type {
  NativeWindow,
  NativeWindowServices,
  WindowChange,
  WindowSnapshot,
} from "@bunaway/plugin-api/native";
import { createOperations } from "#plugins/windows/src/platforms/windows";

const WM_ACTIVATE = 0x0006;
const WM_SETFOCUS = 0x0007;
const WM_KILLFOCUS = 0x0008;
const MAX_ACTIVATION_RECORDS = 64;

test.skipIf(process.platform !== "win32")(
  "two real Win32 windows preserve input on inactive display and report observed activation transitions",
  async () => {
    const { Windows } = await import("#native/windows/bun/win32");
    const { user, kernel } = await import("#native/windows/bun/win32-bindings");
    const { wide } = await import("@bunaway/plugin/win32");
    const { ptr } = await import("bun:ffi");
    const driver = dlopen("user32.dll", {
      GetWindowThreadProcessId: {
        args: [
          "u64",
          "ptr",
        ],
        returns: "u32",
      },
      SetActiveWindow: {
        args: [
          "u64",
        ],
        returns: "u64",
      },
      GetActiveWindow: {
        args: [],
        returns: "u64",
      },
      SetFocus: {
        args: [
          "u64",
        ],
        returns: "u64",
      },
      GetFocus: {
        args: [],
        returns: "u64",
      },
      GetForegroundWindow: {
        args: [],
        returns: "u64",
      },
    });
    const native = new Windows(() => {});
    const handles = new Map<string, bigint>();
    const events: {
      snapshot: WindowSnapshot;
      changes: WindowChange[];
    }[] = [];
    let targetActivations = 0;
    let phase = "create";
    const activationRecords: object[] = [];
    /** Keep the state at each native call boundary without pumping or changing input. */
    function recordActivation(details: object = {}) {
      activationRecords.push({
        phase,
        currentThread: kernel.symbols.GetCurrentThreadId(),
        active: driver.symbols.GetActiveWindow().toString(),
        focus: driver.symbols.GetFocus().toString(),
        foreground: driver.symbols.GetForegroundWindow().toString(),
        ...details,
      });
      if (activationRecords.length > MAX_ACTIVATION_RECORDS) {
        activationRecords.shift();
      }
    }
    function recordMessage(view: string, message: number, wparam: bigint) {
      if (
        [
          WM_ACTIVATE,
          WM_SETFOCUS,
          WM_KILLFOCUS,
        ].includes(message)
      ) {
        recordActivation({
          view,
          message,
          wparam: wparam.toString(),
        });
      }
    }
    const unused = (): never => {
      throw new Error("Unexpected native call");
    };
    function window(view: string): NativeWindow {
      const hwnd = handles.get(view);
      if (!hwnd) {
        throw new Error("Missing native test window");
      }
      return {
        showInactive: () => native.showInactive(hwnd),
        activate: () => native.activate(hwnd),
        show: (visible) => native.show(hwnd, visible),
        focus: () => native.focus(hwnd),
        isFocused: () => native.isFocused(hwnd),
        isMinimized: () => native.isMinimized(hwnd),
        isVisible: () => native.isVisible(hwnd),
        getSnapshot: () => native.getSnapshot(hwnd),
        getReadiness: unused,
        close: unused,
        minimize: unused,
        maximize: unused,
        unmaximize: unused,
        restore: unused,
        toggleMaximize: unused,
        isMaximized: unused,
        isFullscreen: unused,
        getBounds: unused,
        getDpi: unused,
        getSizeConstraints: unused,
        setSizeConstraints: unused,
        setSize: unused,
        setPosition: unused,
        setGeometry: unused,
        setFullscreen: unused,
        setCloseConfirmation: unused,
      };
    }
    const services: NativeWindowServices = {
      specs: [
        "main",
        "editor",
      ].map((view) => ({
        view,
        title: view,
        home: "https://app.bunaway.local",
        window: {
          width: 400,
          height: 300,
        },
      })),
      read: (view) =>
        handles.has(view)
          ? {
              closed: false,
              cleaned: false,
              ready: true,
              failure: null,
              deadline: Infinity,
            }
          : undefined,
      window,
      create: unused,
      close: unused,
      stopping: () => false,
      cancelled: () => false,
      now: Date.now,
      tick: async () => {},
    };
    const execute = createOperations({
      dataRoot: ".",
      capabilities: [],
      windows: services,
    }).executeUI;
    if (!execute) {
      throw new Error("Missing UI adapter");
    }
    const invoke = (operation: string, view: string) =>
      execute(
        operation,
        {
          view,
        },
        "main",
        {
          requestId: operation,
          permissions: {
            permissions: [
              ...windowPermissions(),
            ],
          },
        },
      );
    /** Compare the latest event for each HWND with the same live query used by subscribers. */
    function checkEvents() {
      native.pump();
      for (const [view, hwnd] of handles) {
        const snapshot = native.getSnapshot(hwnd);
        expect(snapshot.state.focused).toBe(native.isFocused(hwnd));
        expect(snapshot.state.visible).toBe(native.isVisible(hwnd));
        const latest = events
          .filter((event) => event.snapshot.viewId === view)
          .at(-1);
        if (latest) {
          expect(latest.snapshot).toEqual(snapshot);
        }
      }
      expect(native.failure).toBeUndefined();
    }
    try {
      const first = native.create(
        "Inactive display input",
        400,
        300,
        (message, wparam) => recordMessage("main", message, wparam),
      );
      handles.set("main", first);
      const second = native.create(
        "Inactive display target",
        500,
        350,
        (message, wparam) => {
          recordMessage("editor", message, wparam);
          if (message === WM_ACTIVATE && (wparam & 0xffffn) !== 0n) {
            targetActivations++;
          }
        },
        false,
      );
      handles.set("editor", second);
      const WS_CHILD = 0x40000000;
      const WS_VISIBLE = 0x10000000;
      const input = user.symbols.CreateWindowExW(
        0,
        ptr(wide("EDIT")),
        ptr(wide("Input focus regression")),
        WS_CHILD | WS_VISIBLE,
        10,
        10,
        250,
        30,
        first,
        0n,
        0n,
        null,
      );
      expect(input).not.toBe(0n);
      const ownership = [
        first,
        second,
        input,
      ].map((hwnd) => {
        const processId = new Uint32Array(1);
        const threadId = driver.symbols.GetWindowThreadProcessId(
          hwnd,
          ptr(processId),
        );
        expect(threadId).toBe(kernel.symbols.GetCurrentThreadId());
        expect(processId[0]).toBe(process.pid);
        return {
          hwnd: hwnd.toString(),
          threadId,
          processId: processId[0],
        };
      });
      console.log("Win32 activation ownership", JSON.stringify(ownership));
      for (const [view, hwnd] of handles) {
        native.observe(hwnd, view, (snapshot, changes) =>
          events.push({
            snapshot,
            changes,
          }),
        );
      }
      for (const state of [
        "normal",
        "minimized",
        "maximized",
        "minimized-from-maximized",
      ] as const) {
        phase = `${state}:placement`;
        native.unmaximize(second);
        if (state === "maximized" || state === "minimized-from-maximized") {
          native.maximize(second);
        }
        if (state === "minimized" || state === "minimized-from-maximized") {
          native.minimize(second);
        }
        for (const hidden of [
          false,
          true,
        ]) {
          phase = `${state}:${hidden ? "hidden" : "visible"}:setup`;
          if (hidden) {
            native.show(second, false);
          }
          native.focus(first);
          recordActivation({
            after: "native.focus",
          });
          // Dispatch placement and foreground setup messages before setting the
          // thread-active HWND and EDIT focus used as the preservation baseline.
          native.pump();
          recordActivation({
            after: "setup pump",
          });
          driver.symbols.SetActiveWindow(first);
          recordActivation({
            after: "SetActiveWindow",
          });
          driver.symbols.SetFocus(input);
          recordActivation({
            after: "SetFocus",
          });
          expect(driver.symbols.GetActiveWindow()).toBe(first);
          expect(driver.symbols.GetFocus()).toBe(input);
          native.pump();
          recordActivation({
            after: "pump",
          });
          expect(driver.symbols.GetActiveWindow()).toBe(first);
          expect(driver.symbols.GetFocus()).toBe(input);
          const before = native.getSnapshot(second);
          const activationsBefore = targetActivations;
          const foregroundBefore = driver.symbols.GetForegroundWindow();
          const start = events.length;
          phase = `${state}:${hidden ? "hidden" : "visible"}:showInactive`;
          expect(await invoke("windows.showInactive", "editor")).toBeNull();
          checkEvents();
          expect(driver.symbols.GetActiveWindow()).toBe(first);
          expect(driver.symbols.GetFocus()).toBe(input);
          expect(targetActivations).toBe(activationsBefore);
          expect(native.isMinimized(second)).toBe(before.state.minimized);
          expect(native.isMaximized(second)).toBe(before.state.maximized);
          expect(native.isVisible(second)).toBe(true);
          expect(native.isFocused(second)).toBe(false);
          if (foregroundBefore === first) {
            expect(driver.symbols.GetForegroundWindow()).toBe(first);
          }
          expect(
            events
              .slice(start)
              .some(
                (event) =>
                  event.snapshot.viewId === "editor" &&
                  event.changes.includes("shown"),
              ),
          ).toBe(hidden);
          const duplicate = events.length;
          await invoke("windows.showInactive", "editor");
          checkEvents();
          expect(events).toHaveLength(duplicate);
        }
        if (state === "minimized-from-maximized") {
          native.restore(second);
          expect(native.isMaximized(second)).toBe(true);
        }
      }
      native.show(second, false);
      const hidden = native.getSnapshot(second);
      expect(await invoke("windows.activate", "editor")).toBe(false);
      expect(native.getSnapshot(second)).toEqual(hidden);
      native.minimize(second);
      const minimized = native.getSnapshot(second);
      expect(await invoke("windows.activate", "editor")).toBe(false);
      expect(native.getSnapshot(second)).toEqual(minimized);
      native.unmaximize(second);
      const activated = await invoke("windows.activate", "main");
      expect(activated).toBe(native.isFocused(first));
      checkEvents();
      if (activated) {
        const start = events.length;
        const blurred = await invoke("windows.blur", "main");
        checkEvents();
        expect(blurred).toBe(!native.isFocused(first));
        if (native.isFocused(second)) {
          expect(
            events
              .slice(start)
              .some(
                (event) =>
                  event.snapshot.viewId === "main" &&
                  event.changes.includes("blur"),
              ),
          ).toBe(true);
          expect(
            events
              .slice(start)
              .some(
                (event) =>
                  event.snapshot.viewId === "editor" &&
                  event.changes.includes("focus"),
              ),
          ).toBe(true);
          console.log(
            "Verified real foreground blur and activation between two Win32 windows.",
          );
        } else {
          console.warn(
            "Foreground blur not verified: Windows declined the successor activation.",
          );
        }
      } else {
        console.warn(
          "Foreground transitions not verified: Windows declined activation. Thread-active and keyboard-focus preservation passed.",
        );
      }
      const noOp = events.length;
      expect(
        await invoke(
          "windows.blur",
          native.isFocused(first) ? "editor" : "main",
        ),
      ).toBe(true);
      checkEvents();
      expect(events).toHaveLength(noOp);
      for (const view of handles.keys()) {
        const revisions = events
          .filter((event) => event.snapshot.viewId === view)
          .map((event) => event.snapshot.revision);
        expect(new Set(revisions).size).toBe(revisions.length);
      }
    } catch (error) {
      console.error(
        "Win32 activation trace",
        JSON.stringify(activationRecords),
      );
      throw error;
    } finally {
      for (const hwnd of [
        ...handles.values(),
      ].reverse()) {
        native.destroy(hwnd);
      }
      native.dispose();
      driver.close();
    }
  },
);
