import { dlopen } from "bun:ffi";
import { expect, test } from "bun:test";
import type { NativeMenuWindowHost } from "@bunaway/plugin-api/native";
import { menuItemsSchema } from "#plugins/menu/src/contract";

test.skipIf(process.platform !== "win32")(
  "real window menu bars own separate trees, dispatch nested selections, resize content and detach before owner destruction",
  async () => {
    const { Windows } = await import("#native/windows/bun/win32");
    const { WindowMenus } = await import(
      "#plugins/menu/src/platforms/windows-window-menus"
    );
    const native = dlopen("user32.dll", {
      GetMenu: {
        args: [
          "u64",
        ],
        returns: "u64",
      },
      GetSubMenu: {
        args: [
          "u64",
          "i32",
        ],
        returns: "u64",
      },
      IsMenu: {
        args: [
          "u64",
        ],
        returns: "i32",
      },
      SendMessageW: {
        args: [
          "u64",
          "u32",
          "u64",
          "i64",
        ],
        returns: "i64",
      },
    });
    const windows = new Windows(() => {});
    const listeners = new Map<
      string,
      Set<{
        receive: Parameters<NativeMenuWindowHost["subscribe"]>[1];
        closing(): void;
      }>
    >();
    const handles = new Map<string, bigint>();
    const roles: string[] = [];
    const host: NativeMenuWindowHost = {
      current: () => handles.keys().next().value ?? "main",
      resolve(id) {
        const hwnd = handles.get(id);
        if (!hwnd) {
          throw new Error("Window not found");
        }
        return hwnd;
      },
      subscribe(id, receive, closing) {
        const entries = listeners.get(id) ?? new Set();
        const entry = {
          receive,
          closing,
        };
        entries.add(entry);
        listeners.set(id, entries);
        return () => {
          entries.delete(entry);
        };
      },
      interrupt: () => () => {},
      changed(id) {
        windows.getSnapshot(host.resolve(id));
      },
      executeRole(id, role) {
        roles.push(`${id}:${role}`);
      },
    };
    const menus = new WindowMenus(host);
    const items = menuItemsSchema.parse([
      {
        id: "file",
        type: "submenu",
        label: "파일 & 😀",
        items: [
          {
            id: "open",
            type: "item",
            label: "열기",
          },
          {
            id: "disabled",
            type: "item",
            label: "Disabled",
            enabled: false,
          },
          {
            id: "copy",
            type: "item",
            role: "copy",
          },
          {
            id: "quit",
            type: "item",
            role: "quit",
          },
          {
            id: "close",
            type: "item",
            role: "close",
          },
          {
            id: "minimize",
            type: "item",
            role: "minimize",
          },
        ],
      },
    ]);
    const selections: string[] = [];
    const closed: string[] = [];
    try {
      for (const id of [
        "one",
        "two",
      ]) {
        const hwnd = windows.create(
          id,
          640,
          480,
          (message, wparam, lparam) => {
            for (const entry of [
              ...(listeners.get(id) ?? []),
            ]) {
              entry.receive(message, wparam, lparam);
            }
          },
          false,
          id === "two"
            ? {
                titlebar: "custom",
              }
            : {},
        );
        handles.set(id, hwnd);
        windows.observe(hwnd, id, () => {});
        menus.set(
          id,
          items,
          (item) => selections.push(`${id}:${item}`),
          () => closed.push(id),
        );
      }
      const first = host.resolve("one");
      const second = host.resolve("two");
      const firstMenu = native.symbols.GetMenu(first);
      let secondMenu = native.symbols.GetMenu(second);
      expect(firstMenu).not.toBe(0n);
      expect(firstMenu).not.toBe(secondMenu);
      const submenu = native.symbols.GetSubMenu(firstMenu, 0);
      native.symbols.SendMessageW(first, 0x0126, 0n, submenu); // WM_MENUCOMMAND
      native.symbols.SendMessageW(first, 0x0126, 1n, submenu); // disabled leaf
      native.symbols.SendMessageW(second, 0x0126, 0n, submenu); // foreign HMENU
      native.symbols.SendMessageW(first, 0x0126, 2n, submenu); // role leaf
      for (const index of [
        3n,
        4n,
        5n,
      ]) {
        native.symbols.SendMessageW(first, 0x0126, index, submenu); // window roles
      }
      // A role runs on its window and is not reported as an app selection.
      expect(roles).toEqual([
        "one:copy",
        "one:quit",
        "one:close",
        "one:minimize",
      ]);
      expect(selections).toEqual([
        "one:open",
      ]);
      windows.setSize(first, 500, 300);
      const content = windows.getBounds(first, "content");
      expect(content.width).toBe(
        Math.round((500 * windows.getDpi(first)) / 96),
      );
      expect(content.height).toBe(
        Math.round((300 * windows.getDpi(first)) / 96),
      );
      for (const skipTaskbar of [
        true,
        false,
      ]) {
        windows.setSkipTaskbar(first, skipTaskbar);
        expect(windows.getBounds(first, "content").width).toBe(content.width);
        expect(windows.getBounds(first, "content").height).toBe(content.height);
      }
      // Content geometry goes through the client rectangle while a menu bar is attached,
      // because the bar can wrap and change the frame height after the first resize.
      // The client size is applied in logical pixels, so expect the rounded round trip.
      const { logicalPixels, physicalPixels } = await import(
        "#native/windows/bun/window-size"
      );
      const geometryDpi = windows.getDpi(first);
      const applied = (physical: number) =>
        physicalPixels(logicalPixels(physical, geometryDpi), geometryDpi);
      windows.setGeometry(first, "content", {
        x: 40,
        y: 60,
        width: 640,
        height: 420,
      });
      expect(windows.getBounds(first, "content")).toMatchObject({
        x: 40,
        y: 60,
        width: applied(640),
        height: applied(420),
      });
      windows.setGeometry(first, "content", {
        width: 600,
        height: 400,
      });
      expect(windows.getBounds(first, "content")).toMatchObject({
        x: 40,
        y: 60,
        width: applied(600),
        height: applied(400),
      });
      windows.setGeometry(first, "content", {
        x: 10,
        y: 20,
      });
      expect(windows.getBounds(first, "content")).toMatchObject({
        x: 10,
        y: 20,
        width: applied(600),
        height: applied(400),
      });
      const wrapped = menuItemsSchema.parse(
        Array.from(
          {
            length: 8,
          },
          (_, index) => ({
            id: `m${index}`,
            type: "submenu",
            label: `Menu heading ${index}`,
            items: [],
          }),
        ),
      );
      menus.set(
        "two",
        wrapped,
        () => {},
        () => {},
      );
      secondMenu = native.symbols.GetMenu(second);
      windows.setSize(second, 300, 300);
      expect(windows.getBounds(second, "content").height).toBe(
        Math.round((300 * windows.getDpi(second)) / 96),
      );
      const wrappedContent = windows.getBounds(second, "content");
      for (const skipTaskbar of [
        true,
        false,
      ]) {
        windows.setSkipTaskbar(second, skipTaskbar);
        expect(windows.getBounds(second, "content").width).toBe(
          wrappedContent.width,
        );
        expect(windows.getBounds(second, "content").height).toBe(
          wrappedContent.height,
        );
        expect(windows.getTitlebar(second)).toBe("custom");
      }
      // Hiding unlinks only the HMENU: the tree stays alive, the outer size is kept
      // and the content area grows by the menu bar height.
      const outer = windows.getBounds(first, "outer");
      const withBar = windows.getBounds(first, "content");
      expect(menus.isVisible("one")).toBe(true);
      menus.setVisible("one", false);
      menus.setVisible("one", false);
      expect(menus.isVisible("one")).toBe(false);
      expect(native.symbols.GetMenu(first)).toBe(0n);
      expect(native.symbols.IsMenu(firstMenu)).toBe(1);
      expect(windows.getBounds(first, "outer")).toEqual(outer);
      expect(windows.getBounds(first, "content").height).toBeGreaterThan(
        withBar.height,
      );
      expect(menus.isVisible("two")).toBe(true);
      expect(native.symbols.GetMenu(second)).toBe(secondMenu);
      menus.setVisible("one", true);
      expect(native.symbols.GetMenu(first)).toBe(firstMenu);
      expect(windows.getBounds(first, "content")).toEqual(withBar);
      menus.set(
        "one",
        menuItemsSchema.parse([
          {
            id: "new",
            type: "item",
            label: "New",
          },
        ]),
        (item) => selections.push(item),
        () => closed.push("one"),
      );
      expect(native.symbols.IsMenu(firstMenu)).toBe(0);
      expect(native.symbols.IsMenu(submenu)).toBe(0);
      native.symbols.SendMessageW(first, 0x0126, 0n, submenu);
      expect(selections).toEqual([
        "one:open",
      ]);
      let replacement = native.symbols.GetMenu(first);
      // A menu attached or replaced while hidden stays hidden until shown again.
      menus.setVisible("one", false);
      expect(native.symbols.GetMenu(first)).toBe(0n);
      expect(native.symbols.IsMenu(replacement)).toBe(1);
      menus.set(
        "one",
        menuItemsSchema.parse([
          {
            id: "hidden",
            type: "item",
            label: "Hidden",
          },
        ]),
        (item) => selections.push(item),
        () => closed.push("one"),
      );
      expect(native.symbols.GetMenu(first)).toBe(0n);
      expect(native.symbols.IsMenu(replacement)).toBe(0);
      menus.setVisible("one", true);
      replacement = native.symbols.GetMenu(first);
      expect(replacement).not.toBe(0n);
      expect(native.symbols.IsMenu(replacement)).toBe(1);
      for (const entry of [
        ...(listeners.get("one") ?? []),
      ]) {
        entry.closing();
      }
      expect(closed).toEqual([
        "one",
      ]);
      expect(native.symbols.GetMenu(first)).toBe(0n);
      expect(native.symbols.IsMenu(replacement)).toBe(0);
      expect(native.symbols.IsMenu(secondMenu)).toBe(1);
      windows.destroy(first);
      handles.delete("one");
      menus.dispose();
      expect(native.symbols.IsMenu(secondMenu)).toBe(0);
      expect(native.symbols.GetMenu(second)).toBe(0n);
    } finally {
      menus.dispose();
      for (const hwnd of handles.values()) {
        windows.destroy(hwnd);
      }
      windows.dispose();
      native.close();
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "an auto-hide menu bar links only after an Alt tap and unlinks on Esc, a command or deactivation",
  async () => {
    const { Windows } = await import("#native/windows/bun/win32");
    const { WindowMenus } = await import(
      "#plugins/menu/src/platforms/windows-window-menus"
    );
    const native = dlopen("user32.dll", {
      GetMenu: {
        args: [
          "u64",
        ],
        returns: "u64",
      },
      GetSubMenu: {
        args: [
          "u64",
          "i32",
        ],
        returns: "u64",
      },
      SendMessageW: {
        args: [
          "u64",
          "u32",
          "u64",
          "i64",
        ],
        returns: "i64",
      },
    });
    const WM_ACTIVATE = 0x0006;
    const WM_KEYDOWN = 0x0100;
    const WM_SYSKEYDOWN = 0x0104;
    const WM_SYSKEYUP = 0x0105;
    const WM_MENUCOMMAND = 0x0126;
    const WM_EXITMENULOOP = 0x0212;
    const VK_MENU = 0x12n;
    const VK_ESCAPE = 0x1bn;
    const windows = new Windows(() => {});
    let receive: Parameters<NativeMenuWindowHost["subscribe"]>[1] = () => {};
    let hwnd = 0n;
    const host: NativeMenuWindowHost = {
      current: () => "main",
      resolve: () => hwnd,
      subscribe(_id, listener) {
        receive = listener;
        return () => {};
      },
      interrupt: () => () => {},
      changed: () => windows.getSnapshot(hwnd),
      executeRole() {},
    };
    const menus = new WindowMenus(host);
    const selections: string[] = [];
    hwnd = windows.create(
      "main",
      640,
      480,
      (message, wparam, lparam) => receive(message, wparam, lparam),
      false,
    );
    try {
      windows.observe(hwnd, "main", () => {});
      menus.set(
        "main",
        menuItemsSchema.parse([
          {
            id: "file",
            type: "submenu",
            label: "File",
            items: [
              {
                id: "open",
                type: "item",
                label: "Open",
              },
            ],
          },
        ]),
        (item) => selections.push(item),
        () => {},
      );
      const tree = native.symbols.GetMenu(hwnd);
      expect(tree).not.toBe(0n);
      const withBar = windows.getBounds(hwnd, "content");
      const key = (message: number, virtualKey: bigint) =>
        native.symbols.SendMessageW(hwnd, message, virtualKey, 0);
      const tap = () => {
        key(WM_SYSKEYDOWN, VK_MENU);
        key(WM_SYSKEYUP, VK_MENU);
      };

      menus.setAutoHide("main", true);
      expect(menus.isAutoHide("main")).toBe(true);
      expect(menus.isVisible("main")).toBe(true);
      expect(native.symbols.GetMenu(hwnd)).toBe(0n);
      const withoutBar = windows.getBounds(hwnd, "content");
      expect(withoutBar.height).toBeGreaterThan(withBar.height);

      // An Alt tap shows the bar and the next one hides it.
      tap();
      expect(native.symbols.GetMenu(hwnd)).toBe(tree);
      expect(windows.getBounds(hwnd, "content")).toEqual(withBar);
      tap();
      expect(native.symbols.GetMenu(hwnd)).toBe(0n);

      // Alt used with another key is not a tap.
      key(WM_SYSKEYDOWN, VK_MENU);
      key(WM_SYSKEYDOWN, 0x46n);
      key(WM_SYSKEYUP, VK_MENU);
      expect(native.symbols.GetMenu(hwnd)).toBe(0n);

      // Esc and losing activation hide a shown bar.
      tap();
      expect(native.symbols.GetMenu(hwnd)).toBe(tree);
      key(WM_KEYDOWN, VK_ESCAPE);
      expect(native.symbols.GetMenu(hwnd)).toBe(0n);
      tap();
      native.symbols.SendMessageW(hwnd, WM_ACTIVATE, 0n, 0);
      expect(native.symbols.GetMenu(hwnd)).toBe(0n);

      // Running a command hides it from the next turn.
      tap();
      native.symbols.SendMessageW(
        hwnd,
        WM_MENUCOMMAND,
        0n,
        native.symbols.GetSubMenu(tree, 0),
      );
      expect(selections).toEqual([
        "open",
      ]);
      await new Promise((done) => setTimeout(done, 20));
      expect(native.symbols.GetMenu(hwnd)).toBe(0n);

      // Leaving the keyboard menu mode that follows a frame Alt tap ends the display too.
      tap();
      expect(native.symbols.GetMenu(hwnd)).toBe(tree);
      native.symbols.SendMessageW(hwnd, WM_EXITMENULOOP, 0n, 0);
      await new Promise((done) => setTimeout(done, 20));
      expect(native.symbols.GetMenu(hwnd)).toBe(0n);

      // A shown bar does not survive replacing or removing the menu.
      tap();
      menus.set(
        "main",
        null,
        () => {},
        () => {},
      );
      menus.set(
        "main",
        menuItemsSchema.parse([
          {
            id: "again",
            type: "item",
            label: "Again",
          },
        ]),
        () => {},
        () => {},
      );
      expect(native.symbols.GetMenu(hwnd)).toBe(0n);
      tap();
      const replacement = native.symbols.GetMenu(hwnd);
      expect(replacement).not.toBe(0n);
      tap();

      // Hidden menus ignore Alt, and turning auto-hide off links the bar again.
      menus.setVisible("main", false);
      tap();
      expect(native.symbols.GetMenu(hwnd)).toBe(0n);
      menus.setVisible("main", true);
      expect(native.symbols.GetMenu(hwnd)).toBe(0n);
      menus.setAutoHide("main", false);
      expect(menus.isAutoHide("main")).toBe(false);
      expect(native.symbols.GetMenu(hwnd)).toBe(replacement);
      tap();
      expect(native.symbols.GetMenu(hwnd)).toBe(replacement);
    } finally {
      menus.dispose();
      windows.destroy(hwnd);
      windows.dispose();
      native.close();
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "real context popup cancellation exits its modal loop and releases its temporary HMENU",
  async () => {
    const { Windows } = await import("#native/windows/bun/win32");
    const { WindowMenus } = await import(
      "#plugins/menu/src/platforms/windows-window-menus"
    );
    const native = dlopen("user32.dll", {
      IsMenu: {
        args: [
          "u64",
        ],
        returns: "i32",
      },
    });
    const controller = new AbortController();
    let popupHandle = 0n;
    let timerMessages = 0;
    const windows = new Windows(() => {});
    const hwnd = windows.create(
      "Context menu regression",
      400,
      300,
      (message, wparam) => {
        if (message === 0x0117) {
          popupHandle = wparam; // WM_INITMENUPOPUP
        }
        if (message === 0x0113) {
          timerMessages++;
          controller.abort();
        } // WM_TIMER, after tracking begins
      },
      true,
    );
    const menus = new WindowMenus({
      current: () => "main",
      resolve: () => hwnd,
      subscribe: () => () => {},
      changed() {},
      executeRole() {},
      interrupt: () => () => {},
    });
    try {
      const items = menuItemsSchema.parse([
        {
          id: "item",
          type: "item",
          label: "Item",
        },
      ]);
      expect(() =>
        menus.popup("one", items, 100, 100, controller.signal),
      ).toThrow("Menu popup cancelled");
      expect(timerMessages).toBeGreaterThan(0);
      expect(popupHandle).not.toBe(0n);
      expect(native.symbols.IsMenu(popupHandle)).toBe(0);
      expect(() =>
        menus.popup("one", items, 100, 100, controller.signal),
      ).toThrow("Menu popup cancelled");
    } finally {
      menus.dispose();
      windows.destroy(hwnd);
      windows.dispose();
      native.close();
    }
  },
  10000,
);

// Abort at tracking entry, where EndMenu can be ignored until the owned timer retries it.
// Windows may end tracking before WM_INITMENUPOPUP once WM_ENTERMENULOOP aborted,
// so only the WM_INITMENUPOPUP case can observe the temporary HMENU.
for (const { trigger, message: triggerMessage, observesHandle } of [
  {
    trigger: "WM_ENTERMENULOOP",
    message: 0x0211,
    observesHandle: false,
  },
  {
    trigger: "WM_INITMENUPOPUP",
    message: 0x0117,
    observesHandle: true,
  },
] as const) {
  test.skipIf(process.platform !== "win32")(
    `real context popup aborted at ${trigger} still exits its modal loop`,
    async () => {
      const { Windows } = await import("#native/windows/bun/win32");
      const { WindowMenus } = await import(
        "#plugins/menu/src/platforms/windows-window-menus"
      );
      const native = dlopen("user32.dll", {
        IsMenu: {
          args: [
            "u64",
          ],
          returns: "i32",
        },
      });
      const controller = new AbortController();
      const listeners = new Set<
        (message: number, wparam: bigint, lparam: bigint) => void
      >();
      let popupHandle = 0n;
      const windows = new Windows(() => {});
      const hwnd = windows.create(
        "Context menu tracking entry regression",
        400,
        300,
        (message, wparam, lparam) => {
          for (const receive of [
            ...listeners,
          ]) {
            receive(message, wparam, lparam);
          }
          if (message === 0x0117) {
            popupHandle = wparam; // WM_INITMENUPOPUP
          }
          if (message === triggerMessage) {
            controller.abort();
          }
        },
        true,
      );
      const menus = new WindowMenus({
        current: () => "main",
        resolve: () => hwnd,
        subscribe(_id, receive) {
          listeners.add(receive);
          return () => {
            listeners.delete(receive);
          };
        },
        changed() {},
        executeRole() {},
        interrupt: () => () => {},
      });
      try {
        const items = menuItemsSchema.parse([
          {
            id: "item",
            type: "item",
            label: "Item",
          },
        ]);
        expect(() =>
          menus.popup("one", items, 100, 100, controller.signal),
        ).toThrow("Menu popup cancelled");
        if (observesHandle) {
          expect(popupHandle).not.toBe(0n);
          expect(native.symbols.IsMenu(popupHandle)).toBe(0);
        }
      } finally {
        menus.dispose();
        windows.destroy(hwnd);
        windows.dispose();
        native.close();
      }
    },
    10000,
  );
}

for (const cancellation of [
  "cancel",
  "cancel-context",
  "session-failure",
  "shutdown",
  "bar-shutdown",
  "bar-early-shutdown",
  "popup-early-shutdown",
] as const) {
  test.skipIf(process.platform !== "win32")(
    `actual Worker ${cancellation} interrupts only the matching native context popup`,
    async () => {
      const { Worker } = await import("node:worker_threads");
      const { Channel } = await import("@bunaway/runtime-bun/worker-channel");
      const generation = crypto.randomUUID();
      const ready = new SharedArrayBuffer(4);
      const worker = new Worker(
        new URL("./windows-context-menu.fixture.ts", import.meta.url),
        {
          workerData: {
            generation,
            bar: cancellation.startsWith("bar-"),
            early: cancellation.endsWith("early-shutdown"),
            ready,
          },
        },
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      let entered = false;
      let released = false;
      let sentCancellation = false;
      let failure: unknown;
      const context = "popup-owner" as import("@bunaway/protocol").HostContext;
      const channel = new Channel(
        worker,
        {
          id: "context-popup",
          generation,
        },
        "main",
        (packet) => {
          if (packet.kind !== "diagnostic") {
            return;
          }
          if (packet.event === "early-ready") {
            sentCancellation = true;
            channel.notify({
              kind: "shutdown",
            });
            Atomics.store(new Int32Array(ready), 0, 1);
            Atomics.notify(new Int32Array(ready), 0);
          }
          if (packet.event === "popup-enter" && !entered) {
            entered = true;
            if (cancellation.endsWith("early-shutdown")) {
              return;
            }
            channel.notify({
              kind: "cancel",
              context,
              requestId: "unrelated",
            });
            channel.notify({
              kind: "cancel-context",
              context: "unrelated" as typeof context,
            });
            timer = setTimeout(() => {
              sentCancellation = true;
              if (cancellation === "cancel") {
                channel.notify({
                  kind: "cancel",
                  context,
                  requestId: "popup",
                });
              } else if (cancellation === "cancel-context") {
                channel.notify({
                  kind: "cancel-context",
                  context,
                });
              } else if (cancellation === "session-failure") {
                channel.notify({
                  kind: "session-failure",
                  route: {
                    viewId: "popup",
                    documentGeneration: 0,
                    context,
                  },
                  error: {
                    code: "INTERNAL",
                    message: "Session closed.",
                  },
                });
              } else {
                channel.notify({
                  kind: "shutdown",
                });
              }
            }, 100);
          } else if (packet.event === "popup-released") {
            expect(sentCancellation).toBe(true);
            released = true;
          }
        },
        (error) => {
          failure = error;
        },
      );
      try {
        const exit = await Promise.race([
          new Promise<number>((resolve, reject) => {
            worker.once("exit", resolve);
            worker.once("error", reject);
          }),
          Bun.sleep(8000).then(() => {
            throw new Error(
              "Context popup Worker did not respond to cancellation.",
            );
          }),
        ]);
        expect(exit).toBe(0);
        expect(entered).toBe(true);
        expect(released).toBe(true);
        expect(failure).toBeUndefined();
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
        channel.close();
        await worker.terminate();
      }
    },
    10000,
  );
}
