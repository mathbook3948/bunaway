import { expect, test } from "bun:test";
import type { NativeEnvironment } from "@bunaway/plugin";
import type { NativeMenuItem } from "@bunaway/plugin-api/native";
import { menuPlugin } from "@bunaway/plugin-menu";
import { NativeRegistry, type JsonValue } from "@bunaway/protocol";
import {
  MAX_MENU_DEPTH,
  MAX_MENU_ITEMS,
  MAX_MENU_RESOURCES,
  menuItemsSchema,
  menuOperations,
} from "#plugins/menu/src/contract";
import { createOperations } from "#plugins/menu/src/platforms/windows";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const item = (id: string) => ({
  id,
  type: "item" as const,
  label: `항목 ${id} & 😀`,
});
function fixture(menus?: NativeEnvironment["menus"]) {
  const adapter = createOperations({
    dataRoot: "unused",
    capabilities: [],
    ...(menus
      ? {
          menus,
        }
      : {}),
  });
  const invoke = async (
    operation: keyof typeof menuOperations,
    input: JsonValue,
    permissions = [
      `menu.${operation}`,
    ],
    signal?: AbortSignal,
  ) => {
    if (!adapter.executeUI) {
      throw new Error("Missing UI adapter.");
    }
    return adapter.executeUI(`menu.${operation}`, input, "backend", {
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
  return {
    adapter,
    invoke,
  };
}

test("menu definitions resolve defaults and reject invalid trees before recursive parsing", () => {
  expect(
    menuItemsSchema.parse([
      item("a"),
    ])[0],
  ).toEqual({
    ...item("a"),
    visible: true,
    enabled: true,
    checked: false,
    group: null,
  });
  for (const invalid of [
    [
      item("a"),
      {
        id: "parent",
        type: "submenu",
        label: "Parent",
        items: [
          item("a"),
        ],
      },
    ],
    [
      {
        ...item("a"),
        label: "bad\0label",
      },
    ],
    [
      {
        ...item("a"),
        label: "bad\ud800label",
      },
    ],
    [
      {
        ...item("a"),
        checked: true,
      },
    ],
    [
      {
        ...item("a"),
        type: "radio",
      },
    ],
    [
      {
        ...item("a"),
        type: "checkbox",
        group: "invalid",
      },
    ],
    [
      {
        ...item("a"),
        type: "radio",
        group: "g",
        checked: true,
      },
      {
        ...item("b"),
        type: "radio",
        group: "g",
        checked: true,
      },
    ],
    [
      {
        ...item("a"),
        accelerator: "Ctrl+A",
      },
    ],
    Array.from(
      {
        length: MAX_MENU_ITEMS + 1,
      },
      (_, index) => item(`i${index}`),
    ),
  ]) {
    expect(menuItemsSchema.safeParse(invalid).success).toBe(false);
  }
  let nested: unknown = [
    item("leaf"),
  ];
  for (let depth = 1; depth < MAX_MENU_DEPTH; depth++) {
    nested = [
      {
        id: `sub${depth}`,
        type: "submenu",
        label: "Sub",
        items: nested,
      },
    ];
  }
  expect(menuItemsSchema.safeParse(nested).success).toBe(true);
  nested = [
    {
      id: "too-deep",
      type: "submenu",
      label: "Sub",
      items: nested,
    },
  ];
  expect(menuItemsSchema.safeParse(nested).success).toBe(false);
});

test("menu operations use separate permissions and preserve resource snapshots", async () => {
  const { invoke, adapter } = fixture();
  expect([
    ...new NativeRegistry([
      menuPlugin,
    ]).operations.keys(),
  ]).toEqual(Object.keys(menuOperations).map((name) => `menu.${name}`));
  await expect(
    invoke(
      "create",
      {
        menuId: "main",
        items: [
          item("a"),
        ],
      },
      [
        "menu.get",
      ],
    ),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  const result = await invoke("create", {
    menuId: "main",
    items: [
      item("a"),
    ],
  });
  if (result && typeof result === "object" && !Array.isArray(result)) {
    result.menuId = "mutated";
  }
  expect(await invoke("list", null)).toEqual([
    "main",
  ]);
  expect(
    await invoke("get", {
      menuId: "main",
    }),
  ).toMatchObject({
    menuId: "main",
    items: [
      {
        id: "a",
      },
    ],
  });
  await expect(
    invoke("create", {
      menuId: "main",
      items: [],
    }),
  ).rejects.toMatchObject({
    code: "BUSY",
  });
  expect(
    await invoke("get", {
      menuId: "absent",
    }),
  ).toBeNull();
  expect(
    await invoke("remove", {
      menuId: "absent",
    }),
  ).toBe(false);
  adapter.dispose();
  await expect(invoke("list", null)).rejects.toMatchObject({
    code: "CANCELLED",
  });
  adapter.dispose();
});

test("nested insertion, updates and removal commit only valid candidates", async () => {
  const { invoke } = fixture();
  await invoke("create", {
    menuId: "main",
    items: [
      {
        id: "sub",
        type: "submenu",
        label: "Sub",
        items: [
          item("a"),
        ],
      },
    ],
  });
  await invoke("insert", {
    menuId: "main",
    parentId: "sub",
    index: 0,
    item: {
      id: "check",
      type: "checkbox",
      label: "Check",
    },
  });
  await invoke("updateItem", {
    menuId: "main",
    itemId: "check",
    changes: {
      checked: true,
      visible: false,
      label: "Changed",
      enabled: false,
    },
  });
  const before = await invoke("get", {
    menuId: "main",
  });
  for (const [operation, input] of [
    [
      "insert",
      {
        menuId: "main",
        index: 0,
        item: item("a"),
      },
    ],
    [
      "insert",
      {
        menuId: "main",
        parentId: "a",
        index: 0,
        item: item("b"),
      },
    ],
    [
      "insert",
      {
        menuId: "main",
        index: 10,
        item: item("b"),
      },
    ],
    [
      "updateItem",
      {
        menuId: "main",
        itemId: "sub",
        changes: {
          checked: true,
        },
      },
    ],
    [
      "updateItem",
      {
        menuId: "main",
        itemId: "a",
        changes: {
          checked: true,
        },
      },
    ],
    [
      "removeItem",
      {
        menuId: "main",
        itemId: "absent",
      },
    ],
  ] satisfies [
    keyof typeof menuOperations,
    JsonValue,
  ][]) {
    await expect(invoke(operation, input)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(
      await invoke("get", {
        menuId: "main",
      }),
    ).toEqual(before);
  }
  await invoke("removeItem", {
    menuId: "main",
    itemId: "sub",
  });
  expect(
    await invoke("get", {
      menuId: "main",
    }),
  ).toEqual({
    menuId: "main",
    items: [],
  });
});

test("tray attachment follows updates, rejects stale clicks and suppresses removed menus", async () => {
  const snapshots: (readonly NativeMenuItem[] | null | undefined)[] = [];
  const clicks: ((id: string) => void)[] = [];
  const events: JsonValue[] = [];
  let rejectChange = false;
  const { invoke, adapter } = fixture({
    setTrayMenu(items, selected) {
      if (rejectChange) {
        throw new Error("Native failure");
      }
      snapshots.push(items);
      if (selected) {
        clicks.push(selected);
      }
    },
    emit(event, payload) {
      expect(event).toBe("menu.clicked");
      events.push(payload);
    },
  });
  await invoke("create", {
    menuId: "main",
    items: [
      item("a"),
    ],
  });
  await invoke("setTrayMenu", {
    menuId: "main",
  });
  expect(await invoke("getTrayMenu", null)).toBe("main");
  clicks[0]?.("a");
  expect(events).toEqual([
    {
      menuId: "main",
      itemId: "a",
      source: "tray",
      windowId: null,
    },
  ]);
  await invoke("replace", {
    menuId: "main",
    items: [
      item("b"),
    ],
  });
  clicks[0]?.("a");
  expect(events).toHaveLength(1);
  clicks[1]?.("b");
  expect(events).toHaveLength(2);
  rejectChange = true;
  await expect(
    invoke("replace", {
      menuId: "main",
      items: [
        item("c"),
      ],
    }),
  ).rejects.toThrow("Native failure");
  expect(
    await invoke("get", {
      menuId: "main",
    }),
  ).toMatchObject({
    items: [
      {
        id: "b",
      },
    ],
  });
  rejectChange = false;
  expect(
    await invoke("remove", {
      menuId: "main",
    }),
  ).toBe(true);
  expect(snapshots.at(-1)).toBeNull();
  clicks[1]?.("b");
  expect(events).toHaveLength(2);
  adapter.dispose();
  expect(snapshots.at(-1)).toBeUndefined();
});

test("menu resources stay bounded and cancelled calls acquire no attachment", async () => {
  const { invoke } = fixture();
  for (let index = 0; index < MAX_MENU_RESOURCES; index++) {
    await invoke("create", {
      menuId: `m${index}`,
      items: [],
    });
  }
  await expect(
    invoke("create", {
      menuId: "overflow",
      items: [],
    }),
  ).rejects.toMatchObject({
    code: "BUSY",
  });
  await expect(
    invoke("setTrayMenu", {
      menuId: "m0",
    }),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  expect(await invoke("getTrayMenu", null)).toBeNull();
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    invoke(
      "remove",
      {
        menuId: "m0",
      },
      [
        "menu.remove",
      ],
      cancelled.signal,
    ),
  ).rejects.toMatchObject({
    code: "CANCELLED",
  });
  expect(await invoke("list", null)).toHaveLength(MAX_MENU_RESOURCES);
});

test("plugin parser enforces strict menu contracts at the native boundary", async () => {
  const parsers = pluginParsers("menu", menuOperations);
  expect(
    (
      await parsers.validateCall({
        operation: "menu.create",
        payload: {
          menuId: "main",
          items: [
            item("a"),
          ],
        },
      })
    ).payload,
  ).toMatchObject({
    items: [
      {
        enabled: true,
        visible: true,
      },
    ],
  });
  await expect(
    parsers.validateCall({
      operation: "menu.setTrayMenu",
      payload: {
        menuId: "main",
        extra: true,
      },
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});
