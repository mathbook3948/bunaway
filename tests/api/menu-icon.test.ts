import { expect, test } from "bun:test";
import type { NativeEnvironment } from "@bunaway/plugin";
import type { NativeMenuItem } from "@bunaway/plugin-api/native";
import { menuOperations } from "#plugins/menu/src/operations";
import {
  create,
  get,
  initializeMenuOperations,
  updateItem,
} from "#plugins/menu/src/platforms/windows";
import { trayIco, trayPngIco } from "../fixtures/tray-icon.ts";

const ico = trayIco().toString("base64");
const otherIco = trayPngIco().toString("base64");

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

test("item and submenu accept an ICO icon, default it to null and keep it in snapshots", () => {
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
          id: "with-icon",
          type: "item",
          label: "Icon",
          icon: ico,
        },
        {
          id: "role",
          type: "item",
          role: "copy",
          icon: otherIco,
        },
        {
          id: "sub",
          type: "submenu",
          label: "Sub",
          icon: ico,
          items: [],
        },
      ],
    }),
  );
  expect(
    result.items.map((entry) => ("icon" in entry ? entry.icon : "-")),
  ).toEqual([
    null,
    ico,
    otherIco,
    ico,
  ]);
  expect(
    get(f.state, {
      menuId: "m",
    })?.items[1],
  ).toMatchObject({
    icon: ico,
  });
});

test("checkbox, radio and separator reject an icon", () => {
  for (const item of [
    {
      id: "c",
      type: "checkbox",
      label: "C",
      icon: ico,
    },
    {
      id: "r",
      type: "radio",
      label: "R",
      group: "g",
      icon: ico,
    },
    {
      id: "s",
      type: "separator",
      icon: ico,
    },
  ]) {
    expect(
      createInput([
        item,
      ]).success,
    ).toBe(false);
  }
});

test("malformed icons are rejected before any native resource is created", () => {
  const truncated = trayIco().subarray(0, 30).toString("base64");
  const badOffset = Buffer.from(trayIco());
  badOffset.writeUInt32LE(0xffff_ff00, 18);
  for (const icon of [
    "",
    "not base64!",
    Buffer.from("plain text, not an icon").toString("base64"),
    truncated,
    badOffset.toString("base64"),
    ico.replace(/=*$/, ""),
    Buffer.alloc(65_537).toString("base64"),
  ]) {
    expect(
      createInput([
        {
          id: "i",
          type: "item",
          label: "I",
          icon,
        },
      ]).success,
    ).toBe(false);
  }
});

test("updateItem sets, replaces and clears the icon and rebuilds attached windows", () => {
  const f = fixture();
  create(
    f.state,
    menuOperations.create.input.parse({
      menuId: "m",
      items: [
        {
          id: "a",
          type: "item",
          label: "A",
        },
        {
          id: "sub",
          type: "submenu",
          label: "Sub",
          items: [
            {
              id: "c",
              type: "checkbox",
              label: "C",
            },
          ],
        },
      ],
    }),
  );
  f.state.setWindow("w", "m", f.state.requireMenu("m"));
  const update = (itemId: string, changes: unknown) =>
    updateItem(
      f.state,
      menuOperations.updateItem.input.parse({
        menuId: "m",
        itemId,
        changes,
      }),
    );
  const iconOf = (itemId: string) =>
    get(f.state, {
      menuId: "m",
    })?.items.find((entry) => entry.id === itemId);
  update("a", {
    icon: ico,
  });
  expect(iconOf("a")).toMatchObject({
    icon: ico,
  });
  update("a", {
    icon: otherIco,
  });
  expect(iconOf("a")).toMatchObject({
    icon: otherIco,
  });
  update("sub", {
    icon: ico,
  });
  expect(iconOf("sub")).toMatchObject({
    icon: ico,
  });
  update("a", {
    icon: null,
  });
  expect(iconOf("a")).toMatchObject({
    icon: null,
  });
  // One initial attachment plus a rebuild for each of the four successful changes.
  expect(f.driverCalls).toHaveLength(5);
  expect(f.driverCalls.at(-1)?.[1]).toMatchObject({
    icon: ico,
  });
});

test("updateItem rejects icons on checkbox, radio and separator and invalid ICO input", () => {
  const f = fixture();
  create(
    f.state,
    menuOperations.create.input.parse({
      menuId: "m",
      items: [
        {
          id: "c",
          type: "checkbox",
          label: "C",
        },
        {
          id: "r",
          type: "radio",
          label: "R",
          group: "g",
        },
        {
          id: "s",
          type: "separator",
        },
        {
          id: "a",
          type: "item",
          label: "A",
        },
      ],
    }),
  );
  for (const itemId of [
    "c",
    "r",
    "s",
  ]) {
    for (const icon of [
      ico,
      null,
    ]) {
      expect(() =>
        updateItem(
          f.state,
          menuOperations.updateItem.input.parse({
            menuId: "m",
            itemId,
            changes: {
              icon,
            },
          }),
        ),
      ).toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
        }),
      );
    }
  }
  for (const icon of [
    "bogus",
    7,
  ]) {
    expect(
      menuOperations.updateItem.input.safeParse({
        menuId: "m",
        itemId: "a",
        changes: {
          icon,
        },
      }).success,
    ).toBe(false);
  }
  expect(
    get(f.state, {
      menuId: "m",
    })?.items[3],
  ).toMatchObject({
    icon: null,
  });
});
