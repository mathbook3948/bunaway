import { dlopen } from "bun:ffi";
import { expect, test } from "bun:test";
import type {
  NativeWindow,
  NativeWindowServices,
  WindowChange,
  WindowSnapshot,
} from "@bunaway/plugin-api/native";
import { createOperations } from "#plugins/windows/src/windows";

const WM_ACTIVATE = 0x0006;

test.skipIf(process.platform !== "win32")(
  "two real Win32 windows preserve input on inactive display and report observed activation transitions",
  async () => {
    const { Windows } = await import("#native/windows/bun/win32");
    const { user, wide } = await import("#native/windows/bun/win32-bindings");
    const { ptr } = await import("bun:ffi");
    const driver = dlopen("user32.dll", {
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
              {
                identifier: "windows:control",
                allow: [
                  {
                    view: "main",
                  },
                  {
                    view: "editor",
                  },
                ],
              },
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
      const first = native.create("Inactive display input", 400, 300, () => {});
      handles.set("main", first);
      const second = native.create(
        "Inactive display target",
        500,
        350,
        (message, wparam) => {
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
          if (hidden) {
            native.show(second, false);
          }
          native.focus(first);
          driver.symbols.SetActiveWindow(first);
          driver.symbols.SetFocus(input);
          native.pump();
          expect(driver.symbols.GetActiveWindow()).toBe(first);
          expect(driver.symbols.GetFocus()).toBe(input);
          const before = native.getSnapshot(second);
          const activationsBefore = targetActivations;
          const foregroundBefore = driver.symbols.GetForegroundWindow();
          const start = events.length;
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
