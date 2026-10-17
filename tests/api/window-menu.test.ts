import { expect, test } from "bun:test";
import { defineNativePlugin, type NativeEnvironment } from "@bunaway/plugin";
import type { NativeMenuItem } from "@bunaway/plugin-api/native";
import { BunawayError, type JsonValue } from "@bunaway/protocol";
import { menuEvents } from "#plugins/menu/src/contract";
import { menuOperations } from "#plugins/menu/src/operations";
import { initializeMenuOperations } from "#plugins/menu/src/platforms/windows";
import type { WindowMenuDriver } from "#plugins/menu/src/platforms/windows-window-menus";
import { nativeFactory } from "../fixtures/native-platform.ts";

const leaf = (id: string) => ({
  id,
  type: "item",
  label: id,
});
function fixture() {
  const alive = new Set([
    "one",
    "two",
  ]);
  const attachments = new Map<
    string,
    {
      items: readonly NativeMenuItem[];
      selected(id: string): void;
      closed(): void;
    }
  >();
  const events: JsonValue[] = [];
  let failAttachment = false;
  let popupAction: (signal: AbortSignal) => string | null = () => "a";
  const driver: WindowMenuDriver = {
    validate(windowId) {
      if (!alive.has(windowId)) {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Missing window",
        });
      }
    },
    set(windowId, items, selected, closed) {
      driver.validate(windowId);
      if (failAttachment) {
        throw new Error("Native attachment failed");
      }
      if (items === null) {
        attachments.delete(windowId);
      } else {
        attachments.set(windowId, {
          items,
          selected,
          closed,
        });
      }
    },
    popup(windowId, _items, _x, _y, signal) {
      driver.validate(windowId);
      return popupAction(signal);
    },
    dispose() {
      for (const attached of attachments.values()) {
        attached.closed();
      }
      attachments.clear();
    },
  };
  let state: ReturnType<typeof initializeMenuOperations> | undefined;
  const declaration = defineNativePlugin({
    name: "menu",
    events: menuEvents,
    platforms: {
      windows: {
        thread: "ui",
        operations: menuOperations,
        initialize(environment: NativeEnvironment) {
          state = initializeMenuOperations(environment, () => driver);
          return state;
        },
        dispose(instance: ReturnType<typeof initializeMenuOperations>) {
          instance.dispose();
        },
      },
    },
  });
  const adapter = nativeFactory(
    declaration,
    "windows",
  )({
    dataRoot: "unused",
    capabilities: [],
    menus: {
      setTrayMenu() {},
      emit(_event, payload) {
        events.push(payload);
      },
    },
  });
  const invoke = (
    name: keyof typeof menuOperations,
    payload: JsonValue,
    signal?: AbortSignal,
    permissions = [
      `menu.${name}`,
    ],
  ) => {
    if (!adapter.executeUI) {
      throw new Error("Missing UI adapter");
    }
    return adapter.executeUI(`menu.${name}`, payload, "backend", {
      requestId: crypto.randomUUID(),
      permissions: {
        permissions,
      },
      ...(signal
        ? {
            signal,
          }
        : {}),
    });
  };
  return {
    invoke,
    adapter,
    attachments,
    events,
    alive,
    fail(value: boolean) {
      failAttachment = value;
    },
    popup(action: typeof popupAction) {
      popupAction = action;
    },
    state() {
      if (!state) {
        throw new Error("Missing state");
      }
      return state;
    },
  };
}

test("window menu attachments are exclusive, update atomically and reject retired selections", async () => {
  const f = fixture();
  await f.invoke("create", {
    menuId: "shared",
    items: [
      leaf("a"),
    ],
  });
  await f.invoke("setWindowMenu", {
    windowId: "one",
    menuId: "shared",
  });
  expect(
    await f.invoke("getWindowMenu", {
      windowId: "one",
    }),
  ).toBe("shared");
  const old = f.attachments.get("one");
  await expect(
    f.invoke("setWindowMenu", {
      windowId: "two",
      menuId: "shared",
    }),
  ).rejects.toMatchObject({
    code: "BUSY",
  });
  await expect(
    f.invoke("setTrayMenu", {
      menuId: "shared",
    }),
  ).rejects.toMatchObject({
    code: "BUSY",
  });
  const wait = f.invoke("waitForClick", null);
  await Bun.sleep(0);
  old?.selected("a");
  expect(await wait).toEqual({
    menuId: "shared",
    itemId: "a",
    source: "window",
    windowId: "one",
  });
  await f.invoke("replace", {
    menuId: "shared",
    items: [
      leaf("b"),
    ],
  });
  old?.selected("a");
  expect(f.events).toHaveLength(1);
  const current = f.attachments.get("one");
  f.fail(true);
  await expect(
    f.invoke("replace", {
      menuId: "shared",
      items: [
        leaf("c"),
      ],
    }),
  ).rejects.toThrow("Native attachment failed");
  expect(
    await f.invoke("get", {
      menuId: "shared",
    }),
  ).toMatchObject({
    items: [
      {
        id: "b",
      },
    ],
  });
  current?.selected("b");
  expect(f.events).toHaveLength(2);
  f.fail(false);
  await f.invoke("remove", {
    menuId: "shared",
  });
  current?.selected("b");
  expect(f.events).toHaveLength(2);
  expect(f.attachments.size).toBe(0);
  expect(
    await f.invoke("getWindowMenu", {
      windowId: "one",
    }),
  ).toBeNull();
  await f.adapter.dispose();
});

test("owner teardown drops only its attachment and resource can attach to a new window lifetime", async () => {
  const f = fixture();
  await f.invoke("create", {
    menuId: "shared",
    items: [
      leaf("a"),
    ],
  });
  await f.invoke("setTrayMenu", {
    menuId: "shared",
  });
  await expect(
    f.invoke("setWindowMenu", {
      windowId: "one",
      menuId: "shared",
    }),
  ).rejects.toMatchObject({
    code: "BUSY",
  });
  await f.invoke("setTrayMenu", {
    menuId: null,
  });
  await f.invoke("setWindowMenu", {
    windowId: "one",
    menuId: "shared",
  });
  const old = f.attachments.get("one");
  old?.closed();
  f.alive.delete("one");
  old?.selected("a");
  expect(f.events).toHaveLength(0);
  await expect(
    f.invoke("getWindowMenu", {
      windowId: "one",
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(
    await f.invoke("get", {
      menuId: "shared",
    }),
  ).not.toBeNull();
  await f.invoke("setWindowMenu", {
    windowId: "two",
    menuId: "shared",
  });
  await f.adapter.dispose();
  f.attachments.get("two")?.selected("a");
  expect(f.events).toHaveLength(0);
});

test("context popup uses a snapshot, reports its owner and handles dismissal, abort and mutation", async () => {
  const f = fixture();
  await f.invoke("create", {
    menuId: "shared",
    items: [
      leaf("a"),
    ],
  });
  const input = {
    menuId: "shared",
    windowId: "one",
    x: -200,
    y: 40,
  };
  expect(await f.invoke("showContextMenu", input)).toBe("a");
  expect(f.events).toEqual([
    {
      menuId: "shared",
      itemId: "a",
      source: "context",
      windowId: "one",
    },
  ]);
  f.popup(() => null);
  expect(await f.invoke("showContextMenu", input)).toBeNull();
  expect(f.events).toHaveLength(1);
  const abort = new AbortController();
  f.popup((signal) => {
    abort.abort();
    expect(signal.aborted).toBe(true);
    return "a";
  });
  await expect(
    f.invoke("showContextMenu", input, abort.signal),
  ).rejects.toMatchObject({
    code: "CANCELLED",
  });
  f.popup((signal) => {
    f.state().commit("shared", [
      leaf("b"),
    ]);
    expect(signal.aborted).toBe(true);
    return "a";
  });
  await expect(f.invoke("showContextMenu", input)).rejects.toMatchObject({
    code: "CANCELLED",
  });
  expect(f.events).toHaveLength(1);
  await f.adapter.dispose();
});

test("window operations retain independent permissions, strict input and cancellation before acquisition", async () => {
  const f = fixture();
  await f.invoke("create", {
    menuId: "shared",
    items: [
      leaf("a"),
    ],
  });
  const input = {
    windowId: "one",
    menuId: "shared",
  };
  await expect(
    f.invoke("setWindowMenu", input, undefined, [
      "menu.create",
    ]),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    f.invoke("setWindowMenu", input, aborted.signal),
  ).rejects.toMatchObject({
    code: "CANCELLED",
  });
  await expect(
    f.invoke("setWindowMenu", {
      ...input,
      hwnd: 123,
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  await expect(
    f.invoke("showContextMenu", {
      ...input,
      x: 0.5,
      y: 0,
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(f.attachments.size).toBe(0);
  await f.adapter.dispose();
});

test("a rejected tray role change leaves an open popup of the same menu untouched", async () => {
  const f = fixture();
  await f.invoke("create", {
    menuId: "shared",
    items: [
      leaf("a"),
    ],
  });
  await f.invoke("setTrayMenu", {
    menuId: "shared",
  });
  f.popup((signal) => {
    expect(() =>
      f.state().commit("shared", [
        {
          id: "copy",
          type: "item",
          role: "copy",
        },
      ]),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
    expect(signal.aborted).toBe(false);
    return "a";
  });
  expect(
    await f.invoke("showContextMenu", {
      menuId: "shared",
      windowId: "one",
      x: 1,
      y: 2,
    }),
  ).toBe("a");
  await f.adapter.dispose();
});

test("role items attach to windows with resolved labels and a role selection reports nothing", async () => {
  const f = fixture();
  await f.invoke("create", {
    menuId: "edit",
    items: [
      {
        id: "paste",
        type: "item",
        role: "paste",
      },
    ],
  });
  await f.invoke("setWindowMenu", {
    windowId: "one",
    menuId: "edit",
  });
  expect(f.attachments.get("one")?.items).toMatchObject([
    {
      id: "paste",
      role: "paste",
      label: "Paste",
    },
  ]);
  // The native owner runs a role itself: it neither calls `selected` nor returns an ID.
  f.popup(() => null);
  expect(
    await f.invoke("showContextMenu", {
      menuId: "edit",
      windowId: "one",
      x: 1,
      y: 2,
    }),
  ).toBeNull();
  expect(f.events).toEqual([]);
  await f.adapter.dispose();
});
