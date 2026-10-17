import { expect, test } from "bun:test";
import type { JsonValue } from "@bunaway/protocol";
import {
  type GlobalShortcut,
  shortcutSchema,
} from "#plugins/global-shortcut/src/contract";
import {
  initializeShortcutOperations,
  type ShortcutDriver,
} from "#plugins/global-shortcut/src/platforms/windows";
import { hotkeyCodes } from "#plugins/global-shortcut/src/platforms/windows-bindings";
import { HeldShortcuts } from "#plugins/global-shortcut/src/release-tracker";

test("held shortcuts report only keys that are no longer down, once", () => {
  const held = new HeldShortcuts();
  expect(held.press(1, 0x41)).toBe(false);
  expect(held.press(2, 0x42)).toBe(false);
  expect(held.poll((key) => key === 0x42)).toEqual([
    1,
  ]);
  expect(held.size).toBe(1);
  expect(held.poll((key) => key === 0x42)).toEqual([]);
  // A press seen again before any poll means a missed release.
  expect(held.press(2, 0x42)).toBe(true);
  expect(held.drop(2)).toBe(true);
  expect(held.drop(2)).toBe(false);
  held.press(3, 0x43);
  held.press(4, 0x44);
  expect(held.clear()).toEqual([
    3,
    4,
  ]);
  expect(held.size).toBe(0);
});

function fixture() {
  const down = new Set<number>();
  const events: string[] = [];
  let receive: (id: number, keys: bigint) => void = () => {};
  let tick: (() => void) | undefined;
  let timerStarts = 0;
  const driver: ShortcutDriver = {
    listen(listener) {
      receive = listener;
    },
    register: () => true,
    unregister: () => true,
    isKeyDown: (key) => down.has(key),
    startPolling(callback) {
      if (!tick) {
        timerStarts++;
      }
      tick = callback;
    },
    stopPolling() {
      tick = undefined;
    },
    dispose() {
      tick = undefined;
    },
  };
  const operations = initializeShortcutOperations(
    driver,
    (event: string, payload: JsonValue) => {
      const key = (
        payload as {
          shortcut: GlobalShortcut;
        }
      ).shortcut.key;
      events.push(`${event.replace("globalShortcut.", "")}:${key}`);
    },
  );
  const press = (id: number, shortcut: GlobalShortcut) => {
    const codes = hotkeyCodes(shortcut);
    down.add(codes.key);
    receive(id, BigInt((codes.key << 16) | codes.modifiers));
  };
  return {
    operations,
    events,
    down,
    press,
    tick: () => tick?.(),
    timerRunning: () => tick !== undefined,
    timerStarts: () => timerStarts,
  };
}
const shortcutA = shortcutSchema.parse({
  key: "A",
  modifiers: [
    "Control",
  ],
});
const shortcutB = shortcutSchema.parse({
  key: "B",
  modifiers: [
    "Control",
  ],
});

test("released follows pressed after the key goes up and the poll stops", () => {
  const f = fixture();
  f.operations.register(shortcutA);
  f.press(1, shortcutA);
  expect(f.events).toEqual([
    "pressed:A",
  ]);
  f.tick();
  expect(f.events).toEqual([
    "pressed:A",
  ]);
  expect(f.timerRunning()).toBe(true);
  f.down.clear();
  f.tick();
  expect(f.events).toEqual([
    "pressed:A",
    "released:A",
  ]);
  expect(f.timerRunning()).toBe(false);
});

test("a repeated press before any poll closes the earlier hold", () => {
  const f = fixture();
  f.operations.register(shortcutA);
  f.press(1, shortcutA);
  f.press(1, shortcutA);
  expect(f.events).toEqual([
    "pressed:A",
    "released:A",
    "pressed:A",
  ]);
  expect(f.timerStarts()).toBe(1);
});

test("unregister and suspend release held keys, dispose stays silent", () => {
  const f = fixture();
  f.operations.registerMany([
    shortcutA,
    shortcutB,
  ]);
  f.press(1, shortcutA);
  f.press(2, shortcutB);
  f.operations.unregister(shortcutA);
  expect(f.events).toEqual([
    "pressed:A",
    "pressed:B",
    "released:A",
  ]);
  expect(f.timerRunning()).toBe(true);
  f.operations.setSuspended(true);
  expect(f.events.at(-1)).toBe("released:B");
  expect(f.timerRunning()).toBe(false);
  f.operations.setSuspended(false);
  f.operations.unregisterAll();
  f.operations.register(shortcutA);
  // Native IDs are never reused: 1-2 initially, 3 after resume, 4 for this registration.
  f.press(4, shortcutA);
  const before = f.events.length;
  f.operations.dispose();
  f.tick();
  expect(f.events).toHaveLength(before);
});
