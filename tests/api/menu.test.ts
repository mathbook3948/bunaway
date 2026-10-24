import { expect, test } from "bun:test";
import type { NativeEnvironment } from "@bunaway/plugin";
import type { NativeMenuItem } from "@bunaway/plugin-api/native";
import menu from "@bunaway/plugin-menu";
import { isRecord, type JsonValue, NativeRegistry } from "@bunaway/protocol";
import {
  MAX_MENU_DEPTH,
  MAX_MENU_ITEMS,
  MAX_MENU_RESOURCES,
  menuItemsSchema,
} from "#plugins/menu/src/contract";
import createOperationsDefinition from "#plugins/menu/src/index";
import { menuOperations } from "#plugins/menu/src/operations";
import { nativeFactory as createOperationsFactory } from "../fixtures/native-platform.ts";

import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const createOperations = createOperationsFactory(
  createOperationsDefinition,
  "windows",
);

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
  if (!adapter) {
    throw new Error("Missing validated adapter");
  }
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

test("menu labels accept 512 Unicode code points and reject 513 regardless of UTF-16 width", async () => {
  const parsers = pluginParsers("menu", menuOperations);
  for (const label of [
    "x".repeat(512),
    "😀".repeat(257),
    "😀".repeat(512),
  ]) {
    const call = await parsers.validateCall({
      operation: "menu.create",
      payload: {
        menuId: "boundary",
        items: [
          {
            id: "item",
            type: "item",
            label,
          },
        ],
      },
    });
    expect(call.payload).toMatchObject({
      items: [
        {
          label,
        },
      ],
    });
  }
  expect("😀".repeat(512).length).toBe(1024);
  for (const label of [
    "",
    "x".repeat(513),
    "😀".repeat(513),
  ]) {
    await expect(
      parsers.validateCall({
        operation: "menu.create",
        payload: {
          menuId: "boundary",
          items: [
            {
              id: "item",
              type: "item",
              label,
            },
          ],
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
});

test("menu definitions resolve defaults and reject invalid trees before recursive parsing", () => {
  expect(
    menuOperations.create.input.safeParse({
      menuId: "trailing\n",
      items: [],
    }).success,
  ).toBe(false);
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
    icon: null,
    accelerator: null,
  });
  for (const invalid of [
    [
      {
        id: "trailing\n",
        type: "separator",
      },
    ],
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
        accelerator: "Ctrl+",
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
      menu._definition,
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
  if (isRecord(result)) {
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
  await adapter.dispose();
  await expect(invoke("list", null)).rejects.toMatchObject({
    code: "CANCELLED",
  });
  await adapter.dispose();
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
  await adapter.dispose();
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
  await expect(
    parsers.validateCall({
      operation: "menu.replace",
      payload: {
        menuId: "main",
        items: [
          item("duplicate"),
          item("duplicate"),
        ],
      },
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});

test("windowless backend click waits are cancellable, bounded and receive no replay", async () => {
  let selected: ((id: string) => void) | undefined;
  const { invoke, adapter } = fixture({
    setTrayMenu(_items, receive) {
      selected = receive;
    },
    emit() {},
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
  selected?.("a");
  const controller = new AbortController();
  const first = invoke(
    "waitForClick",
    null,
    [
      "menu.waitForClick",
    ],
    controller.signal,
  );
  let settled = false;
  void first.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Bun.sleep(0);
  expect(settled).toBe(false);
  controller.abort();
  await expect(first).rejects.toMatchObject({
    code: "CANCELLED",
  });
  const waiting = invoke("waitForClick", null);
  // Parsing is asynchronous; let the owning adapter install the wait before native input.
  await Bun.sleep(0);
  selected?.("a");
  expect(await waiting).toEqual({
    menuId: "main",
    itemId: "a",
    source: "tray",
    windowId: null,
  });
  const pending = Array.from(
    {
      length: 16,
    },
    () => invoke("waitForClick", null),
  );
  const results = Promise.allSettled(pending);
  await expect(invoke("waitForClick", null)).rejects.toMatchObject({
    code: "BUSY",
  });
  await adapter.dispose();
  for (const result of await results) {
    expect(result).toMatchObject({
      status: "rejected",
      reason: {
        code: "CANCELLED",
      },
    });
  }
});

test("role items default their label, keep an explicit label and reject roles elsewhere", () => {
  const roles = [
    [
      "undo",
      "Undo",
    ],
    [
      "redo",
      "Redo",
    ],
    [
      "cut",
      "Cut",
    ],
    [
      "copy",
      "Copy",
    ],
    [
      "paste",
      "Paste",
    ],
    [
      "selectAll",
      "Select All",
    ],
  ] as const;
  expect(
    menuItemsSchema.parse(
      roles.map(([role]) => ({
        id: role,
        type: "item",
        role,
      })),
    ),
  ).toMatchObject(
    roles.map(([role, label]) => ({
      role,
      label,
    })),
  );
  expect(
    menuItemsSchema.parse([
      {
        id: "copy",
        type: "item",
        role: "copy",
        label: "복사",
      },
    ])[0],
  ).toMatchObject({
    role: "copy",
    label: "복사",
  });
  // Plain items carry no role key, so existing snapshots are unchanged.
  expect(
    "role" in
      (menuItemsSchema.parse([
        item("plain"),
      ])[0] ?? {}),
  ).toBe(false);
  const rejected = [
    // Without a role, a label is still required.
    {
      id: "a",
      type: "item",
    },
    {
      id: "a",
      type: "checkbox",
    },
    {
      id: "a",
      type: "checkbox",
      label: "A",
      role: "copy",
    },
    {
      id: "a",
      type: "radio",
      label: "A",
      group: "g",
      role: "copy",
    },
    {
      id: "a",
      type: "submenu",
      label: "A",
      role: "copy",
      items: [],
    },
    {
      id: "a",
      type: "separator",
      role: "copy",
    },
    {
      id: "a",
      type: "item",
      role: "close",
    },
    {
      id: "a",
      type: "item",
      role: "copy",
      checked: true,
    },
  ];
  for (const candidate of rejected) {
    expect(
      menuItemsSchema.safeParse([
        candidate,
      ]).success,
    ).toBe(false);
  }
  expect(
    menuOperations.updateItem.input.safeParse({
      menuId: "m",
      itemId: "a",
      changes: {
        role: "copy",
      },
    }).success,
  ).toBe(false);
});

test("tray menus reject roles at any depth and keep the previous definition", async () => {
  const snapshots: (readonly NativeMenuItem[] | null | undefined)[] = [];
  const { invoke } = fixture({
    setTrayMenu(items) {
      snapshots.push(items);
    },
    emit() {},
  });
  const roleItem = {
    id: "copy",
    type: "item",
    role: "copy",
  };
  await invoke("create", {
    menuId: "roles",
    items: [
      {
        id: "edit",
        type: "submenu",
        label: "Edit",
        items: [
          roleItem,
        ],
      },
    ],
  });
  await expect(
    invoke("setTrayMenu", {
      menuId: "roles",
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(await invoke("getTrayMenu", null)).toBeNull();
  await invoke("create", {
    menuId: "plain",
    items: [
      item("a"),
    ],
  });
  await invoke("setTrayMenu", {
    menuId: "plain",
  });
  const attached = snapshots.length;
  // Edits to the attached tray menu that introduce a role are refused as a whole.
  await expect(
    invoke("insert", {
      menuId: "plain",
      index: 0,
      item: roleItem,
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  await expect(
    invoke("replace", {
      menuId: "plain",
      items: [
        roleItem,
      ],
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(snapshots).toHaveLength(attached);
  expect(
    await invoke("get", {
      menuId: "plain",
    }),
  ).toMatchObject({
    items: [
      {
        id: "a",
      },
    ],
  });
});

test("menu items reject sublabel and accessibility label fields instead of ignoring them", () => {
  const parse = (entry: Record<string, unknown>) =>
    menuOperations.create.input.safeParse({
      menuId: "extra",
      items: [
        {
          id: "parent",
          type: "submenu",
          label: "Parent",
          items: [
            entry,
          ],
        },
      ],
    });
  const entries = [
    {
      id: "entry",
      type: "separator",
    },
    {
      id: "entry",
      type: "item",
      label: "Open",
    },
    {
      id: "entry",
      type: "item",
      role: "copy",
    },
    {
      id: "entry",
      type: "checkbox",
      label: "Open",
    },
    {
      id: "entry",
      type: "radio",
      label: "Open",
      group: "choice",
      checked: true,
    },
    {
      id: "entry",
      type: "submenu",
      label: "Open",
      items: [],
    },
  ];
  for (const entry of entries) {
    expect(parse(entry).error?.issues).toBeUndefined();
    for (const extra of [
      {
        sublabel: "Hint",
      },
      {
        accessibleLabel: "Open",
      },
    ]) {
      const result = parse({
        ...entry,
        ...extra,
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.code).toBe("unrecognized_keys");
    }
  }
});

test("insert and updateItem reject sublabel and accessibility label fields", () => {
  for (const extra of [
    {
      sublabel: "Hint",
    },
    {
      accessibleLabel: "Open",
    },
  ]) {
    const inserted = menuOperations.insert.input.safeParse({
      menuId: "extra",
      index: 0,
      item: {
        id: "entry",
        type: "item",
        label: "Open",
        ...extra,
      },
    });
    expect(inserted.success).toBe(false);
    const updated = menuOperations.updateItem.input.safeParse({
      menuId: "extra",
      itemId: "entry",
      changes: {
        ...extra,
      },
    });
    expect(updated.success).toBe(false);
    expect(updated.error?.issues[0]?.code).toBe("unrecognized_keys");
  }
});
