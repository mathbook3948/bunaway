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
    const host: NativeMenuWindowHost = {
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
      const replacement = native.symbols.GetMenu(first);
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
      resolve: () => hwnd,
      subscribe: () => () => {},
      changed() {},
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
        resolve: () => hwnd,
        subscribe(_id, receive) {
          listeners.add(receive);
          return () => {
            listeners.delete(receive);
          };
        },
        changed() {},
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
