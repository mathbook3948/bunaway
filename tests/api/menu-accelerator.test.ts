import { expect, test } from "bun:test";
import type { NativeEnvironment } from "@bunaway/plugin";
import type { NativeMenuItem } from "@bunaway/plugin-api/native";
import {
  MAX_ACCELERATOR_LENGTH,
  normalizeAccelerator,
} from "#plugins/menu/src/contract";
import { menuOperations } from "#plugins/menu/src/operations";
import {
  create,
  get,
  initializeMenuOperations,
  updateItem,
} from "#plugins/menu/src/platforms/windows";

const menus: NonNullable<NativeEnvironment["menus"]> = {
  setTrayMenu() {},
  emit() {},
};

function fixture() {
  const driverCalls: (readonly NativeMenuItem[] | null)[] = [];
  const state = initializeMenuOperations(
    {
      dataRoot: "unused",
      capabilities: [],
      menus,
    },
    () => ({
      current: () => "window",
      validate() {},
      set(_windowId, items) {
        driverCalls.push(items);
      },
      setVisible() {},
      isVisible: () => true,
      popup: () => null,
      dispose() {},
    }),
  );
  return {
    state,
    driverCalls,
  };
}
const createInput = (items: unknown) =>
  menuOperations.create.input.safeParse({
    menuId: "m",
    items,
  });

test("accelerator text is normalized to Ctrl, Alt, Shift, Win order and canonical key names", () => {
  expect(normalizeAccelerator("ctrl+shift+n")).toBe("Ctrl+Shift+N");
  expect(normalizeAccelerator("Shift+Control+n")).toBe("Ctrl+Shift+N");
  expect(normalizeAccelerator("CommandOrControl+S")).toBe("Ctrl+S");
  expect(normalizeAccelerator("CmdOrCtrl+Alt+f5")).toBe("Ctrl+Alt+F5");
  expect(normalizeAccelerator("Super+pageup")).toBe("Win+PageUp");
  expect(normalizeAccelerator("f24")).toBe("F24");
  expect(normalizeAccelerator("Delete")).toBe("Delete");
  expect(normalizeAccelerator("7")).toBe("7");
});

test("accelerator text with an unknown key, modifier or shape is rejected", () => {
  for (const text of [
    "",
    "Ctrl+",
    "+N",
    "Ctrl+Shift",
    "Ctrl+Ctrl+N",
    "Control+Ctrl+N",
    "Cmd+N",
    "Meta+N",
    "Ctrl+F0",
    "Ctrl+F25",
    "Ctrl+NN",
    "Ctrl + N",
    "Ctrl+N\t",
    "Ctrl+\n",
    "Ctrl+Plus",
    "constructor+N",
    "__proto__+N",
    "Ctrl+constructor+N",
    "Ctrl+toString+N",
    `${"Ctrl+".repeat(MAX_ACCELERATOR_LENGTH)}N`,
  ]) {
    expect(normalizeAccelerator(text)).toBeUndefined();
    expect(
      createInput([
        {
          id: "a",
          type: "item",
          label: "A",
          accelerator: text,
        },
      ]).success,
    ).toBe(false);
  }
});

test("item, checkbox and radio keep a normalized accelerator and default it to null", () => {
  const f = fixture();
  const result = create(
    f.state,
    menuOperations.create.input.parse({
      menuId: "m",
      items: [
        {
          id: "plain",
          type: "item",
          label: "Plain",
        },
        {
          id: "new",
          type: "item",
          label: "New",
          accelerator: "cmdorctrl+n",
        },
        {
          id: "check",
          type: "checkbox",
          label: "Check",
          accelerator: "F11",
        },
        {
          id: "radio",
          type: "radio",
          label: "Radio",
          group: "g",
          accelerator: "Alt+1",
        },
        {
          id: "copy",
          type: "item",
          role: "copy",
          accelerator: "Ctrl+Insert",
        },
      ],
    }),
  );
  expect(
    result.items.map((entry) =>
      "accelerator" in entry ? entry.accelerator : "-",
    ),
  ).toEqual([
    null,
    "Ctrl+N",
    "F11",
    "Alt+1",
    "Ctrl+Insert",
  ]);
  expect(
    get(f.state, {
      menuId: "m",
    })?.items[1],
  ).toMatchObject({
    accelerator: "Ctrl+N",
  });
});

test("submenu and separator reject an accelerator", () => {
  for (const item of [
    {
      id: "s",
      type: "submenu",
      label: "S",
      items: [],
      accelerator: "Ctrl+S",
    },
    {
      id: "sep",
      type: "separator",
      accelerator: "Ctrl+S",
    },
  ]) {
    expect(
      createInput([
        item,
      ]).success,
    ).toBe(false);
  }
});

test("updateItem sets, replaces and clears the accelerator", () => {
  const f = fixture();
  create(
    f.state,
    menuOperations.create.input.parse({
      menuId: "m",
      items: [
        {
          id: "save",
          type: "item",
          label: "Save",
        },
      ],
    }),
  );
  const change = (accelerator: string | null) =>
    updateItem(
      f.state,
      menuOperations.updateItem.input.parse({
        menuId: "m",
        itemId: "save",
        changes: {
          accelerator,
        },
      }),
    );
  expect(change("ctrl+s")?.items[0]).toMatchObject({
    accelerator: "Ctrl+S",
  });
  expect(change("Ctrl+Shift+S")?.items[0]).toMatchObject({
    accelerator: "Ctrl+Shift+S",
  });
  expect(change(null)?.items[0]).toMatchObject({
    accelerator: null,
  });
});

test("updateItem rejects an invalid accelerator and one on a submenu or separator", () => {
  const f = fixture();
  create(
    f.state,
    menuOperations.create.input.parse({
      menuId: "m",
      items: [
        {
          id: "sub",
          type: "submenu",
          label: "Sub",
          items: [],
        },
        {
          id: "sep",
          type: "separator",
        },
      ],
    }),
  );
  expect(
    menuOperations.updateItem.input.safeParse({
      menuId: "m",
      itemId: "sub",
      changes: {
        accelerator: "Ctrl+Nope",
      },
    }).success,
  ).toBe(false);
  for (const itemId of [
    "sub",
    "sep",
  ]) {
    let thrown: unknown;
    try {
      updateItem(
        f.state,
        menuOperations.updateItem.input.parse({
          menuId: "m",
          itemId,
          changes: {
            accelerator: "Ctrl+S",
          },
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  // The rejected updates leave the stored tree untouched.
  expect(
    get(f.state, {
      menuId: "m",
    })?.items,
  ).toEqual([
    expect.not.objectContaining({
      accelerator: "Ctrl+S",
    }),
    expect.not.objectContaining({
      accelerator: "Ctrl+S",
    }),
  ]);
});
