import { expect, test } from "bun:test";
import globalShortcut from "@bunaway/plugin-global-shortcut";
import type { JsonValue } from "@bunaway/protocol";
import { NativeRegistry } from "@bunaway/protocol";
import {
  type GlobalShortcut,
  hotkeyCodes,
  shortcutSchema,
} from "#plugins/global-shortcut/src/contract";
import { globalShortcutOperations } from "#plugins/global-shortcut/src/operations";
import type { ShortcutDriver } from "#plugins/global-shortcut/src/shortcut-adapter";
import { createShortcutOperations } from "../fixtures/injected-native-plugins.ts";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const shortcut = (key: GlobalShortcut["key"]): GlobalShortcut => ({
  key,
  modifiers: [
    "Control",
    "Shift",
  ],
});
function fixture() {
  const native = new Map<number, GlobalShortcut>();
  const released: number[] = [];
  const occupied = new Set<string>();
  const failedRemoval = new Set<number>();
  const events: JsonValue[] = [];
  let receive: (id: number, keys: bigint) => void = () => {};
  let disposed = 0;
  const driver: ShortcutDriver = {
    listen(listener) {
      receive = listener;
    },
    register(id, shortcut) {
      if (occupied.has(shortcut.key)) {
        return false;
      }
      native.set(id, shortcut);
      return true;
    },
    unregister(id) {
      if (failedRemoval.has(id)) {
        return false;
      }
      released.push(id);
      return native.delete(id);
    },
    dispose() {
      disposed++;
      native.clear();
    },
  };
  const adapter = createShortcutOperations(driver, (event, payload) => {
    expect(event).toBe("globalShortcut.pressed");
    events.push(payload);
  });
  const invoke = async (
    name: keyof typeof globalShortcutOperations,
    input: JsonValue,
    permissions = [
      `globalShortcut.${name}`,
    ],
    signal?: AbortSignal,
  ) => {
    if (!adapter.executeUI) {
      throw new Error("Missing UI adapter");
    }
    return adapter.executeUI(`globalShortcut.${name}`, input, "backend", {
      requestId: "test",
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
  const press = (id: number, value: GlobalShortcut) => {
    const codes = hotkeyCodes(value);
    receive(id, BigInt((codes.key << 16) | codes.modifiers));
  };
  return {
    adapter,
    invoke,
    native,
    occupied,
    failedRemoval,
    released,
    events,
    press,
    disposed: () => disposed,
  };
}

test("global shortcut schemas normalize modifier order and reject invalid/reserved inputs", async () => {
  const parsers = pluginParsers("globalShortcut", globalShortcutOperations);
  expect(
    (
      await parsers.validateCall({
        operation: "globalShortcut.register",
        payload: {
          key: "K",
          modifiers: [
            "Shift",
            "Control",
          ],
        },
      })
    ).payload,
  ).toEqual(shortcut("K"));
  for (const invalid of [
    {
      key: "F12",
      modifiers: [
        "Control",
      ],
    },
    {
      key: "a",
      modifiers: [
        "Control",
      ],
    },
    {
      key: "A",
      modifiers: [],
    },
    {
      key: "A",
      modifiers: [
        "Control",
        "Control",
      ],
    },
    {
      key: "A",
      modifiers: [
        "Ctrl",
      ],
    },
    {
      key: "A",
      modifiers: [
        "Alt",
      ],
      extra: true,
    },
  ]) {
    expect(shortcutSchema.safeParse(invalid).success).toBe(false);
  }
  expect(
    hotkeyCodes(
      shortcutSchema.parse({
        key: "F24",
        modifiers: [
          "Super",
          "Control",
          "Alt",
          "Shift",
        ],
      }),
    ),
  ).toEqual({
    key: 0x87,
    modifiers: 15,
  });
  expect(hotkeyCodes(shortcut("Escape")).key).toBe(0x1b);
  expect([
    ...new NativeRegistry([
      globalShortcut._definition,
    ]).operations.keys(),
  ]).toEqual(
    Object.keys(globalShortcutOperations).map(
      (name) => `globalShortcut.${name}`,
    ),
  );
});

test("registration, queries and removal keep independent permissions and lifetime", async () => {
  const f = fixture();
  await expect(
    f.invoke("register", shortcut("K"), [
      "globalShortcut.isRegistered",
    ]),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  expect(f.native.size).toBe(0);
  await f.invoke("register", shortcut("K"));
  expect(
    await f.invoke("isRegistered", {
      key: "K",
      modifiers: [
        "Shift",
        "Control",
      ],
    }),
  ).toBe(true);
  expect(await f.invoke("list", null)).toEqual([
    shortcut("K"),
  ]);
  await expect(f.invoke("register", shortcut("K"))).rejects.toMatchObject({
    code: "BUSY",
  });
  expect(await f.invoke("unregister", shortcut("A"))).toBe(false);
  expect(await f.invoke("unregister", shortcut("K"))).toBe(true);
  const oldId = f.released[0];
  if (oldId === undefined) {
    throw new Error("Missing retired native ID");
  }
  await f.invoke("register", shortcut("K"));
  f.press(oldId, shortcut("K"));
  expect(f.events).toHaveLength(0);
  const id = [
    ...f.native.keys(),
  ][0];
  if (id === undefined) {
    throw new Error("Missing active native ID");
  }
  f.press(id, shortcut("A"));
  expect(f.events).toHaveLength(0);
  f.press(id, shortcut("K"));
  expect(f.events).toEqual([
    {
      shortcut: shortcut("K"),
    },
  ]);
  await f.adapter.dispose();
  await f.adapter.dispose();
  expect(f.disposed()).toBe(1);
  expect(f.native.size).toBe(0);
  f.press(id, shortcut("K"));
  expect(f.events).toHaveLength(1);
  await expect(f.invoke("list", null)).rejects.toMatchObject({
    code: "CANCELLED",
  });
});

test("conflicting batch rolls back without changing existing registrations", async () => {
  const f = fixture();
  await f.invoke("register", shortcut("A"));
  f.occupied.add("C");
  await expect(
    f.invoke("registerMany", {
      shortcuts: [
        shortcut("B"),
        shortcut("C"),
      ],
    }),
  ).rejects.toMatchObject({
    code: "BUSY",
  });
  expect(await f.invoke("list", null)).toEqual([
    shortcut("A"),
  ]);
  expect([
    ...f.native.values(),
  ]).toEqual([
    shortcut("A"),
  ]);
  await expect(
    f.invoke("registerMany", {
      shortcuts: [
        shortcut("B"),
        {
          key: "B",
          modifiers: [
            "Shift",
            "Control",
          ],
        },
      ],
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(f.native.size).toBe(1);
  await f.invoke("unregisterAll", null);
  expect(f.native.size).toBe(0);
});

test("suspension preserves registration state, blocks new bindings and rejects stale queued presses", async () => {
  const f = fixture();
  await f.invoke("registerMany", {
    shortcuts: [
      shortcut("A"),
      shortcut("B"),
    ],
  });
  const originalIds = [
    ...f.native.keys(),
  ];
  await f.invoke("setSuspended", {
    suspended: true,
  });
  expect(await f.invoke("isSuspended", null)).toBe(true);
  expect(await f.invoke("isRegistered", shortcut("A"))).toBe(true);
  expect(f.native.size).toBe(0);
  for (const id of originalIds) {
    f.press(id, shortcut("A"));
  }
  expect(f.events).toHaveLength(0);
  await f.invoke("setSuspended", {
    suspended: true,
  });
  await expect(f.invoke("register", shortcut("C"))).rejects.toMatchObject({
    code: "BUSY",
  });
  f.occupied.add("B");
  await expect(
    f.invoke("setSuspended", {
      suspended: false,
    }),
  ).rejects.toMatchObject({
    code: "BUSY",
  });
  expect(await f.invoke("isSuspended", null)).toBe(true);
  expect(await f.invoke("list", null)).toEqual([
    shortcut("A"),
    shortcut("B"),
  ]);
  expect(f.native.size).toBe(0);
  f.occupied.clear();
  await f.invoke("setSuspended", {
    suspended: false,
  });
  await f.invoke("setSuspended", {
    suspended: false,
  });
  expect(await f.invoke("isSuspended", null)).toBe(false);
  for (const id of originalIds) {
    f.press(id, shortcut("A"));
  }
  expect(f.events).toHaveLength(0);
  const id = [
    ...f.native.keys(),
  ][0];
  if (id === undefined) {
    throw new Error("Missing resumed native ID");
  }
  f.press(id, shortcut("A"));
  expect(f.events).toEqual([
    {
      shortcut: shortcut("A"),
    },
  ]);
});

test("failed native release retains ownership, suppresses input, and can be retried", async () => {
  const f = fixture();
  await f.invoke("registerMany", {
    shortcuts: [
      shortcut("A"),
      shortcut("B"),
    ],
  });
  const id = [
    ...f.native.keys(),
  ][0];
  if (id === undefined) {
    throw new Error("Missing native ID");
  }
  f.failedRemoval.add(id);
  await expect(
    f.invoke("setSuspended", {
      suspended: true,
    }),
  ).rejects.toMatchObject({
    code: "INTERNAL",
  });
  expect(await f.invoke("isSuspended", null)).toBe(true);
  expect(f.native.size).toBe(1);
  f.press(id, shortcut("A"));
  expect(f.events).toHaveLength(0);
  await expect(f.invoke("unregister", shortcut("A"))).rejects.toMatchObject({
    code: "INTERNAL",
  });
  expect(await f.invoke("isRegistered", shortcut("A"))).toBe(true);
  f.failedRemoval.clear();
  await f.invoke("setSuspended", {
    suspended: false,
  });
  expect(f.native.size).toBe(2);
  expect(await f.invoke("isSuspended", null)).toBe(false);
});

test("cancelled registration never acquires a native binding", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    f.invoke(
      "register",
      shortcut("K"),
      [
        "globalShortcut.register",
      ],
      controller.signal,
    ),
  ).rejects.toMatchObject({
    code: "CANCELLED",
  });
  expect(f.native.size).toBe(0);
});

test("rollback and bulk-removal failures retain only bindings that still need cleanup", async () => {
  const f = fixture();
  f.occupied.add("B");
  f.failedRemoval.add(1);
  await expect(
    f.invoke("registerMany", {
      shortcuts: [
        shortcut("A"),
        shortcut("B"),
      ],
    }),
  ).rejects.toMatchObject({
    code: "INTERNAL",
  });
  expect(await f.invoke("list", null)).toEqual([
    shortcut("A"),
  ]);
  f.occupied.clear();
  await f.invoke("register", shortcut("C"));
  await expect(f.invoke("unregisterAll", null)).rejects.toMatchObject({
    code: "INTERNAL",
  });
  expect(await f.invoke("list", null)).toEqual([
    shortcut("A"),
  ]);
  expect(f.native.size).toBe(1);
  f.failedRemoval.clear();
  await f.invoke("unregisterAll", null);
  expect(f.native.size).toBe(0);
});

test("registration capacity is checked before acquiring any part of an oversized batch", async () => {
  const f = fixture();
  const keys = shortcutSchema.shape.key.options;
  const modifiers = [
    "Control",
    "Alt",
    "Shift",
  ] as const;
  const shortcuts = Array.from(
    {
      length: 128,
    },
    (_, index) => {
      const key = keys[index % keys.length];
      const modifier = modifiers[Math.floor(index / keys.length)];
      if (!key || !modifier) {
        throw new Error("Invalid capacity fixture.");
      }
      return {
        key,
        modifiers: [
          modifier,
        ],
      };
    },
  );
  await f.invoke("registerMany", {
    shortcuts,
  });
  expect(f.native.size).toBe(128);
  await expect(f.invoke("register", shortcut("K"))).rejects.toMatchObject({
    code: "BUSY",
  });
  expect(f.native.size).toBe(128);
});

test("backend press waits work without a view, survive suspension and release on cancellation", async () => {
  const f = fixture();
  await f.invoke("register", shortcut("K"));
  const id = [
    ...f.native.keys(),
  ][0];
  if (id === undefined) {
    throw new Error("Missing native ID.");
  }
  f.press(id, shortcut("K"));
  const controller = new AbortController();
  const waiting = f.invoke(
    "waitForPress",
    null,
    [
      "globalShortcut.waitForPress",
    ],
    controller.signal,
  );
  let settled = false;
  void waiting.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await f.invoke("setSuspended", {
    suspended: true,
  });
  f.press(id, shortcut("K"));
  await Bun.sleep(0);
  expect(settled).toBe(false);
  await f.invoke("setSuspended", {
    suspended: false,
  });
  const resumedId = [
    ...f.native.keys(),
  ][0];
  if (resumedId === undefined) {
    throw new Error("Missing resumed ID.");
  }
  f.press(resumedId, shortcut("K"));
  expect(await waiting).toEqual({
    shortcut: shortcut("K"),
  });
  const cancelled = f.invoke(
    "waitForPress",
    null,
    [
      "globalShortcut.waitForPress",
    ],
    controller.signal,
  );
  controller.abort();
  await expect(cancelled).rejects.toMatchObject({
    code: "CANCELLED",
  });
  const pending = Array.from(
    {
      length: 16,
    },
    () => f.invoke("waitForPress", null),
  );
  const results = Promise.allSettled(pending);
  await expect(f.invoke("waitForPress", null)).rejects.toMatchObject({
    code: "BUSY",
  });
  await f.adapter.dispose();
  for (const result of await results) {
    expect(result).toMatchObject({
      status: "rejected",
      reason: {
        code: "CANCELLED",
      },
    });
  }
});
