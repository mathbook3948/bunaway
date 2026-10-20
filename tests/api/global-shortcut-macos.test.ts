import { expect, test } from "bun:test";
import globalShortcut from "@bunaway/plugin-global-shortcut";
import type { JsonValue } from "@bunaway/protocol";
import {
  type GlobalShortcut,
  shortcutSchema,
} from "#plugins/global-shortcut/src/contract";
import { MacosGlobalShortcut } from "#plugins/global-shortcut/src/platforms/macos";
import {
  carbonHotKeyCodes,
  EVENT_HOT_KEY_EXISTS,
  type HotKeyDriver,
  isMacosKey,
} from "#plugins/global-shortcut/src/platforms/macos-bindings";

const shortcut = (key: GlobalShortcut["key"]): GlobalShortcut => ({
  key,
  modifiers: [
    "Control",
    "Shift",
  ],
});

/** A Carbon stand-in that records registrations and lets the test deliver key events. */
function fixture() {
  const native = new Map<number, GlobalShortcut>();
  const removed: number[] = [];
  const occupied = new Set<string>();
  const failedRemoval = new Set<number>();
  const events: {
    event: string;
    payload: JsonValue;
  }[] = [];
  let receive: (event: "pressed" | "released", id: number) => void = () => {};
  let disposed = 0;
  const driver: HotKeyDriver = {
    listen(listener) {
      receive = listener;
    },
    register(id, value) {
      if (occupied.has(value.key)) {
        return EVENT_HOT_KEY_EXISTS;
      }
      native.set(id, value);
      return 0;
    },
    unregister(id) {
      if (failedRemoval.has(id)) {
        return false;
      }
      removed.push(id);
      return native.delete(id);
    },
    dispose() {
      disposed++;
      native.clear();
    },
  };
  const adapter = new MacosGlobalShortcut(driver, (event, payload) => {
    events.push({
      event,
      payload,
    });
  });
  const idOf = (key: GlobalShortcut["key"]) => {
    const found = [
      ...native,
    ].find(([, value]) => value.key === key);
    if (!found) {
      throw new Error(`${key} is not registered natively.`);
    }
    return found[0];
  };
  return {
    adapter,
    native,
    removed,
    occupied,
    failedRemoval,
    events,
    idOf,
    deliver: (event: "pressed" | "released", id: number) => receive(event, id),
    disposed: () => disposed,
  };
}

const errorCode = (action: () => unknown) => {
  try {
    action();
  } catch (error) {
    return (
      error as {
        code?: string;
      }
    ).code;
  }
  return undefined;
};

test("every contract key except those a Mac keyboard lacks maps to one distinct Carbon key code", () => {
  const keys = shortcutSchema.shape.key.options;
  const unsupported = keys.filter((key) => !isMacosKey(key));
  expect(unsupported).toEqual([
    "F21",
    "F22",
    "F23",
    "F24",
    "Insert",
  ]);
  const codes = keys
    .filter(isMacosKey)
    .map((key) => carbonHotKeyCodes(shortcut(key)).keyCode);
  expect(new Set(codes).size).toBe(codes.length);
  // Spot checks against Events.h: kVK_ANSI_A, kVK_Return, kVK_Delete, kVK_ForwardDelete, kVK_F1.
  expect(carbonHotKeyCodes(shortcut("A")).keyCode).toBe(0);
  expect(carbonHotKeyCodes(shortcut("Enter")).keyCode).toBe(36);
  expect(carbonHotKeyCodes(shortcut("Backspace")).keyCode).toBe(51);
  expect(carbonHotKeyCodes(shortcut("Delete")).keyCode).toBe(117);
  expect(carbonHotKeyCodes(shortcut("F1")).keyCode).toBe(122);
});

test("Super is Command, Alt is Option and the modifiers combine into the Carbon mask", () => {
  const mask = (modifiers: GlobalShortcut["modifiers"]) =>
    carbonHotKeyCodes({
      key: "K",
      modifiers,
    }).modifiers;
  expect(
    mask([
      "Super",
    ]),
  ).toBe(0x0100);
  expect(
    mask([
      "Alt",
    ]),
  ).toBe(0x0800);
  expect(
    mask([
      "Control",
      "Alt",
      "Shift",
      "Super",
    ]),
  ).toBe(0x1000 | 0x0800 | 0x0200 | 0x0100);
});

test("the plugin registers a macOS platform that shares the Windows operations", () => {
  const definition = (
    globalShortcut as unknown as {
      _definition: {
        nativePlatforms: Record<string, unknown>;
      };
    }
  )._definition;
  expect(Object.keys(definition.nativePlatforms).sort()).toEqual([
    "macos",
    "windows",
  ]);
});

test("registration, listing and removal follow the shared contract", () => {
  const { adapter, native, removed } = fixture();
  expect(adapter.register(shortcut("K"))).toBeNull();
  expect(adapter.isRegistered(shortcut("K"))).toBe(true);
  expect(adapter.list()).toEqual([
    shortcut("K"),
  ]);
  expect(native.size).toBe(1);
  expect(errorCode(() => adapter.register(shortcut("K")))).toBe("BUSY");
  expect(
    errorCode(() =>
      adapter.registerMany([
        shortcut("L"),
        shortcut("L"),
      ]),
    ),
  ).toBe("INVALID_ARGUMENT");
  expect(adapter.unregister(shortcut("K"))).toBe(true);
  expect(adapter.unregister(shortcut("K"))).toBe(false);
  expect(removed).toHaveLength(1);
  expect(adapter.list()).toEqual([]);
});

test("a combination another registration owns is BUSY and a batch rolls back", () => {
  const { adapter, native, occupied } = fixture();
  occupied.add("M");
  expect(errorCode(() => adapter.register(shortcut("M")))).toBe("BUSY");
  expect(
    errorCode(() =>
      adapter.registerMany([
        shortcut("K"),
        shortcut("M"),
      ]),
    ),
  ).toBe("BUSY");
  expect(native.size).toBe(0);
  expect(adapter.list()).toEqual([]);
});

test("a key a Mac keyboard lacks is refused before any registration", () => {
  const { adapter, native } = fixture();
  expect(
    errorCode(() =>
      adapter.registerMany([
        shortcut("K"),
        shortcut("Insert"),
      ]),
    ),
  ).toBe("UNSUPPORTED");
  expect(errorCode(() => adapter.register(shortcut("F21")))).toBe(
    "UNSUPPORTED",
  );
  expect(native.size).toBe(0);
});

test("a rollback that fails keeps ownership of what remained registered", () => {
  const { adapter, native, occupied, failedRemoval, idOf } = fixture();
  occupied.add("M");
  // The first registration gets id 1; its removal fails during the rollback.
  failedRemoval.add(1);
  expect(
    errorCode(() =>
      adapter.registerMany([
        shortcut("K"),
        shortcut("M"),
      ]),
    ),
  ).toBe("INTERNAL");
  expect(idOf("K")).toBe(1);
  expect(adapter.list()).toEqual([
    shortcut("K"),
  ]);
  expect(native.size).toBe(1);
});

test("a press publishes pressed and wakes a waiter, the release reports released once", async () => {
  const { adapter, events, idOf, deliver } = fixture();
  adapter.register(shortcut("K"));
  const id = idOf("K");
  const waiting = adapter.waitForPress();
  deliver("pressed", id);
  expect(await waiting).toEqual({
    shortcut: shortcut("K"),
  });
  deliver("released", id);
  // A release without a hold is ignored.
  deliver("released", id);
  expect(events.map((entry) => entry.event)).toEqual([
    "globalShortcut.pressed",
    "globalShortcut.released",
  ]);
  expect(events[0]?.payload).toEqual({
    shortcut: shortcut("K"),
  });
});

test("a second press without a release closes the earlier hold first", () => {
  const { adapter, events, idOf, deliver } = fixture();
  adapter.register(shortcut("K"));
  const id = idOf("K");
  deliver("pressed", id);
  deliver("pressed", id);
  expect(events.map((entry) => entry.event)).toEqual([
    "globalShortcut.pressed",
    "globalShortcut.released",
    "globalShortcut.pressed",
  ]);
});

test("unregistering a held shortcut completes the pair and later events are ignored", () => {
  const { adapter, events, idOf, deliver } = fixture();
  adapter.register(shortcut("K"));
  const id = idOf("K");
  deliver("pressed", id);
  adapter.unregister(shortcut("K"));
  deliver("pressed", id);
  deliver("released", id);
  expect(events.map((entry) => entry.event)).toEqual([
    "globalShortcut.pressed",
    "globalShortcut.released",
  ]);
});

test("suspending releases the native keys and resuming registers them again with new ids", () => {
  const { adapter, native, events, idOf, deliver } = fixture();
  adapter.register(shortcut("K"));
  const before = idOf("K");
  deliver("pressed", before);
  expect(adapter.setSuspended(true)).toBeNull();
  expect(adapter.isSuspended()).toBe(true);
  expect(native.size).toBe(0);
  // The hold ended with the suspension; the retired id no longer reports.
  deliver("pressed", before);
  expect(errorCode(() => adapter.register(shortcut("L")))).toBe("BUSY");
  expect(adapter.list()).toEqual([
    shortcut("K"),
  ]);
  expect(adapter.setSuspended(false)).toBeNull();
  const after = idOf("K");
  expect(after).not.toBe(before);
  deliver("pressed", before);
  deliver("pressed", after);
  expect(events.map((entry) => entry.event)).toEqual([
    "globalShortcut.pressed",
    "globalShortcut.released",
    "globalShortcut.pressed",
  ]);
});

test("unregisterAll removes everything and reports a removal that failed", () => {
  const { adapter, native, failedRemoval } = fixture();
  adapter.registerMany([
    shortcut("K"),
    shortcut("L"),
  ]);
  failedRemoval.add(2);
  expect(errorCode(() => adapter.unregisterAll())).toBe("INTERNAL");
  expect(adapter.list()).toEqual([
    shortcut("L"),
  ]);
  failedRemoval.clear();
  expect(adapter.unregisterAll()).toBeNull();
  expect(native.size).toBe(0);
});

test("dispose removes the native side once, cancels waiters and ignores later events", async () => {
  const { adapter, events, idOf, deliver, disposed } = fixture();
  adapter.register(shortcut("K"));
  const id = idOf("K");
  const waiting = adapter.waitForPress();
  adapter.dispose();
  adapter.dispose();
  expect(disposed()).toBe(1);
  expect(
    await waiting.then(
      () => "resolved",
      (error: { code?: string }) => error.code,
    ),
  ).toBe("CANCELLED");
  deliver("pressed", id);
  expect(events).toEqual([]);
});

test("a resume that fails and cannot roll back reports both failures and stays suspended", () => {
  const { adapter, occupied, failedRemoval } = fixture();
  adapter.registerMany([
    shortcut("K"),
    shortcut("L"),
  ]);
  adapter.setSuspended(true);
  occupied.add("L");
  // The suspended registrations got ids 1 and 2, so the resume registers K as id 3.
  failedRemoval.add(3);
  let thrown: unknown;
  try {
    adapter.setSuspended(false);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AggregateError);
  expect(
    (thrown as AggregateError).errors.map(
      (item: { code?: string }) => item.code,
    ),
  ).toEqual([
    "BUSY",
    "INTERNAL",
  ]);
  expect(adapter.isSuspended()).toBe(true);
  // Once the removal works again, the next resume unbinds first and then reports the real conflict.
  failedRemoval.clear();
  expect(errorCode(() => adapter.setSuspended(false))).toBe("BUSY");
  occupied.clear();
  expect(adapter.setSuspended(false)).toBeNull();
  expect(adapter.isSuspended()).toBe(false);
});
