import { expect, test } from "bun:test";
import type { JsonValue } from "@bunaway/protocol";
import {
  MAX_MACOS_TRAY_IMAGE_BYTES,
  MAX_MACOS_TRAY_IMAGE_SIDE_PIXELS,
  MAX_MACOS_TRAY_ITEM_ID_LENGTH,
  MAX_MACOS_TRAY_LABEL_UNITS,
  MAX_MACOS_TRAY_MENU_ITEMS,
  MAX_MACOS_TRAY_TITLE_UNITS,
} from "#plugins/tray/src/contract";
import { macosTrayOperations } from "#plugins/tray/src/operations-macos";
import { MacosTray } from "#plugins/tray/src/platforms/macos";
import type {
  NativeImage,
  NativeMenuEntry,
  StatusItemBinding,
} from "#plugins/tray/src/platforms/macos-status-item";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";
import { headerOnlyPng, solidPng } from "../fixtures/tray-png.ts";

/** A binding that does nothing; tests override the calls they observe. */
const inertBinding: StatusItemBinding = {
  setTitle: () => {},
  setTooltip: () => {},
  setMenu: () => {},
  setImage: () => {},
  readBack: () => ({
    title: "",
    tooltip: "",
    image: null,
    menu: null,
  }),
  activate: () => {},
  dispose: () => {},
};

/** Records what the adapter asks AppKit to do, and lets a test choose an entry like a user would. */
function fakeBinding() {
  const log: string[] = [];
  let select: (tag: number) => void = () => {};
  let menu: readonly NativeMenuEntry[] | null = null;
  let image: NativeImage | null = null;
  const factory = (onSelect: (tag: number) => void): StatusItemBinding => {
    select = onSelect;
    log.push("create");
    return {
      ...inertBinding,
      setTitle: (title) => void log.push(`title:${title}`),
      setTooltip: (tooltip) => void log.push(`tooltip:${tooltip}`),
      setMenu: (entries) => {
        menu = entries;
        log.push(`menu:${entries?.length ?? "none"}`);
      },
      setImage: (next) => {
        image = next;
        log.push(`image:${next ? "set" : "none"}`);
      },
      dispose: () => void log.push("dispose"),
    };
  };
  return {
    factory,
    image: () => image,
    log,
    choose: (tag: number) => select(tag),
    menu: () => menu,
  };
}

test("macOS tray inputs are strict, bounded and reject unrepresentable text", async () => {
  const parsers = pluginParsers("tray", macosTrayOperations);
  const accepted: [
    string,
    JsonValue,
  ][] = [
    [
      "tray.create",
      {},
    ],
    [
      "tray.create",
      {
        title: "한글 😀",
        tooltip: "t",
      },
    ],
    [
      "tray.setTitle",
      {
        title: "x".repeat(MAX_MACOS_TRAY_TITLE_UNITS),
      },
    ],
    [
      "tray.setMenu",
      {
        items: [
          {
            type: "item",
            id: "open",
            label: "Open",
          },
          {
            type: "separator",
          },
          {
            type: "item",
            id: "quit",
            label: "Quit",
            enabled: false,
          },
        ],
      },
    ],
    [
      "tray.setMenu",
      {
        items: null,
      },
    ],
    [
      "tray.setImage",
      {
        image: null,
      },
    ],
    [
      "tray.setImage",
      {
        image: {
          png: solidPng(2, 2).toString("base64"),
        },
      },
    ],
    [
      "tray.setImage",
      {
        image: {
          png: solidPng(2, 2).toString("base64"),
          template: true,
          scale: 2,
          description: "Notes",
        },
      },
    ],
  ];
  for (const [operation, payload] of accepted) {
    await parsers.validateCall({
      operation,
      payload,
    });
  }
  const item = (id: string, label = "L") => ({
    type: "item",
    id,
    label,
  });
  const png = solidPng(2, 2).toString("base64");
  const rejected: [
    string,
    JsonValue,
  ][] = [
    [
      "tray.setImage",
      {},
    ],
    [
      "tray.setImage",
      {
        image: {},
      },
    ],
    [
      "tray.setImage",
      {
        image: {
          png: "not base64!",
        },
      },
    ],
    [
      "tray.setImage",
      {
        image: {
          png: "",
        },
      },
    ],
    [
      "tray.setImage",
      {
        image: {
          png: Buffer.alloc(MAX_MACOS_TRAY_IMAGE_BYTES + 1).toString("base64"),
        },
      },
    ],
    [
      "tray.setImage",
      {
        image: {
          png,
          scale: 3,
        },
      },
    ],
    [
      "tray.setImage",
      {
        image: {
          png,
          template: "yes",
        },
      },
    ],
    [
      "tray.setImage",
      {
        image: {
          png,
          description: "a\0b",
        },
      },
    ],
    [
      "tray.setImage",
      {
        image: {
          png,
          extra: 1,
        },
      },
    ],
    [
      "tray.create",
      {
        title: "a",
        extra: 1,
      },
    ],
    [
      "tray.setTitle",
      {
        title: "x".repeat(MAX_MACOS_TRAY_TITLE_UNITS + 1),
      },
    ],
    [
      "tray.setTitle",
      {
        title: "a\0b",
      },
    ],
    [
      "tray.setTitle",
      {
        title: "\ud800",
      },
    ],
    [
      "tray.setMenu",
      {
        items: [
          item("a"),
          item("a"),
        ],
      },
    ],
    [
      "tray.setMenu",
      {
        items: [
          item(""),
        ],
      },
    ],
    [
      "tray.setMenu",
      {
        items: [
          item("x".repeat(MAX_MACOS_TRAY_ITEM_ID_LENGTH + 1)),
        ],
      },
    ],
    [
      "tray.setMenu",
      {
        items: [
          item("a", ""),
        ],
      },
    ],
    [
      "tray.setMenu",
      {
        items: [
          item("a", "x".repeat(MAX_MACOS_TRAY_LABEL_UNITS + 1)),
        ],
      },
    ],
    [
      "tray.setMenu",
      {
        items: [
          item("a", "a\0b"),
        ],
      },
    ],
    [
      "tray.setMenu",
      {
        items: Array.from(
          {
            length: MAX_MACOS_TRAY_MENU_ITEMS + 1,
          },
          (_, index) => item(`id${index}`),
        ),
      },
    ],
    [
      "tray.setMenu",
      {
        items: [
          {
            type: "submenu",
            id: "s",
            label: "S",
          },
        ],
      },
    ],
  ];
  for (const [operation, payload] of rejected) {
    await expect(
      parsers.validateCall({
        operation,
        payload,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
});

test("the menu bar item exists only between create and destroy", () => {
  const native = fakeBinding();
  const tray = new MacosTray(native.factory);
  expect(tray.get()).toBeNull();
  for (const call of [
    () => tray.setTitle("a"),
    () => tray.setTooltip("a"),
    () => tray.setMenu(null),
    () => tray.setImage(null),
    () => tray.waitForMenuClick(),
  ]) {
    expect(call).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED",
      }),
    );
  }
  expect(tray.create("Title", "Tip")).toEqual({
    id: "main",
    title: "Title",
    tooltip: "Tip",
    hasMenu: false,
    hasImage: false,
  });
  expect(() => tray.create("again", "")).toThrow(
    expect.objectContaining({
      code: "BUSY",
    }),
  );
  tray.setTitle("Next");
  tray.setTooltip("Hint");
  expect(tray.get()).toMatchObject({
    title: "Next",
    tooltip: "Hint",
  });
  expect(tray.destroy()).toBeNull();
  expect(tray.destroy()).toBeNull();
  expect(tray.get()).toBeNull();
  expect(native.log).toEqual([
    "create",
    "title:Title",
    "tooltip:Tip",
    "title:Next",
    "tooltip:Hint",
    "dispose",
  ]);
  // A destroyed item can be created again.
  expect(tray.create("", "").title).toBe("");
});

test("a failed initial setup releases the native item and leaves no tray behind", () => {
  const log: string[] = [];
  const tray = new MacosTray(() => ({
    ...inertBinding,
    setTitle: () => {
      throw new Error("title failed");
    },
    dispose: () => void log.push("dispose"),
  }));
  expect(() => tray.create("a", "b")).toThrow("title failed");
  expect(log).toEqual([
    "dispose",
  ]);
  expect(tray.get()).toBeNull();
});

test("menu choices resolve waiters by item id and ignore separators and stale tags", async () => {
  const native = fakeBinding();
  const tray = new MacosTray(native.factory);
  tray.create("", "");
  tray.setMenu([
    {
      type: "item",
      id: "open",
      label: "Open",
      enabled: true,
    },
    {
      type: "separator",
    },
    {
      type: "item",
      id: "quit",
      label: "Quit",
      enabled: false,
    },
  ]);
  expect(tray.get()?.hasMenu).toBe(true);
  expect(native.menu()).toEqual([
    {
      kind: "item",
      label: "Open",
      enabled: true,
      tag: 0,
    },
    {
      kind: "separator",
    },
    {
      kind: "item",
      label: "Quit",
      enabled: false,
      tag: 2,
    },
  ]);
  const first = tray.waitForMenuClick();
  native.choose(1);
  native.choose(9);
  native.choose(2);
  await expect(first).resolves.toEqual({
    id: "quit",
  });
  // Replacing the menu renumbers tags, so a tag from the old menu maps to the new list.
  tray.setMenu([
    {
      type: "item",
      id: "only",
      label: "Only",
      enabled: true,
    },
  ]);
  const second = tray.waitForMenuClick();
  native.choose(2);
  native.choose(0);
  await expect(second).resolves.toEqual({
    id: "only",
  });
  tray.setMenu(null);
  expect(tray.get()?.hasMenu).toBe(false);
  native.choose(0);
});

test("a failed menu replacement keeps the previous menu ids", () => {
  let fail = false;
  const tray = new MacosTray(() => ({
    ...inertBinding,
    setMenu: () => {
      if (fail) {
        throw new Error("menu failed");
      }
    },
  }));
  tray.create("", "");
  tray.setMenu([
    {
      type: "item",
      id: "a",
      label: "A",
      enabled: true,
    },
  ]);
  fail = true;
  expect(() => tray.setMenu(null)).toThrow("menu failed");
  expect(tray.get()?.hasMenu).toBe(true);
});

test("disposal removes the item and cancels waiting callers", async () => {
  const native = fakeBinding();
  const tray = new MacosTray(native.factory);
  tray.create("", "");
  const waiting = tray.waitForMenuClick();
  const outcome = waiting.then(
    () => null,
    (error: unknown) => error,
  );
  tray.dispose();
  expect(await outcome).toMatchObject({
    code: "CANCELLED",
  });
  expect(native.log.at(-1)).toBe("dispose");
  expect(tray.get()).toBeNull();
});

test("a wait ends with CANCELLED when its signal aborts", async () => {
  const tray = new MacosTray(fakeBinding().factory);
  tray.create("", "");
  const controller = new AbortController();
  const waiting = tray.waitForMenuClick(controller.signal);
  const outcome = waiting.then(
    () => null,
    (error: unknown) => error,
  );
  controller.abort();
  expect(await outcome).toMatchObject({
    code: "CANCELLED",
  });
});

test("destroy cancels pending waits and a new item does not inherit them", async () => {
  const native = fakeBinding();
  const tray = new MacosTray(native.factory);
  tray.create("", "");
  tray.setMenu([
    {
      type: "item",
      id: "a",
      label: "A",
      enabled: true,
    },
  ]);
  const outcome = tray.waitForMenuClick().then(
    () => null,
    (error: unknown) => error,
  );
  tray.destroy();
  expect(await outcome).toMatchObject({
    code: "CANCELLED",
  });
  tray.create("", "");
  tray.setMenu([
    {
      type: "item",
      id: "b",
      label: "B",
      enabled: true,
    },
  ]);
  const next = tray.waitForMenuClick();
  native.choose(0);
  expect(await next).toEqual({
    id: "b",
  });
});

test("an empty menu removes the menu", () => {
  const native = fakeBinding();
  const tray = new MacosTray(native.factory);
  tray.create("", "");
  tray.setMenu([]);
  expect(tray.get()?.hasMenu).toBe(false);
  expect(native.menu()).toBeNull();
});

test("an image reaches AppKit in points with its template flag and is removed with null", () => {
  const native = fakeBinding();
  const tray = new MacosTray(native.factory);
  tray.create("", "");
  expect(tray.get()?.hasImage).toBe(false);

  tray.setImage({
    png: solidPng(44, 22).toString("base64"),
    template: true,
    scale: 2,
    description: "Notes",
  });
  expect(tray.get()?.hasImage).toBe(true);
  const shown = native.image();
  expect(shown).toMatchObject({
    widthPoints: 22,
    heightPoints: 11,
    template: true,
    description: "Notes",
  });
  expect(shown?.data).toEqual(new Uint8Array(solidPng(44, 22)));

  // The default is a 1x image that macOS does not tint.
  tray.setImage({
    png: solidPng(18, 18).toString("base64"),
    template: false,
    scale: 1,
    description: "",
  });
  expect(native.image()).toMatchObject({
    widthPoints: 18,
    heightPoints: 18,
    template: false,
  });

  tray.setImage(null);
  expect(native.image()).toBeNull();
  expect(tray.get()?.hasImage).toBe(false);
});

test("an image that is not a PNG or exceeds the side bound is rejected before AppKit", () => {
  const native = fakeBinding();
  const tray = new MacosTray(native.factory);
  tray.create("", "");
  const image = (bytes: Buffer) => ({
    png: bytes.toString("base64"),
    template: false,
    scale: 1 as const,
    description: "",
  });
  const invalid = expect.objectContaining({
    code: "INVALID_ARGUMENT",
  });
  for (const bytes of [
    Buffer.from("not a png at all, just text of some length"),
    solidPng(2, 2).subarray(0, 12),
    headerOnlyPng(MAX_MACOS_TRAY_IMAGE_SIDE_PIXELS + 1, 16),
    headerOnlyPng(16, MAX_MACOS_TRAY_IMAGE_SIDE_PIXELS + 1),
    headerOnlyPng(0, 16),
  ]) {
    expect(() => tray.setImage(image(bytes))).toThrow(invalid);
  }
  expect(() =>
    tray.setImage(image(headerOnlyPng(MAX_MACOS_TRAY_IMAGE_SIDE_PIXELS, 1))),
  ).not.toThrow();
  // Only the accepted call reached the binding.
  expect(native.log.filter((entry) => entry.startsWith("image:"))).toEqual([
    "image:set",
  ]);
});

test("a failed image replacement keeps the previous image state", () => {
  let fail = false;
  const binding: StatusItemBinding = {
    ...inertBinding,
    setImage: () => {
      if (fail) {
        throw new Error("decode failed");
      }
    },
  };
  const tray = new MacosTray(() => binding);
  tray.create("", "");
  const image = {
    png: solidPng(2, 2).toString("base64"),
    template: false,
    scale: 1 as const,
    description: "",
  };
  tray.setImage(image);
  fail = true;
  expect(() => tray.setImage(image)).toThrow("decode failed");
  expect(tray.get()?.hasImage).toBe(true);
  expect(() => tray.setImage(null)).toThrow("decode failed");
  expect(tray.get()?.hasImage).toBe(true);
});

test("destroy forgets the image so a new item starts without one", () => {
  const native = fakeBinding();
  const tray = new MacosTray(native.factory);
  tray.create("", "");
  tray.setImage({
    png: solidPng(2, 2).toString("base64"),
    template: false,
    scale: 1,
    description: "",
  });
  tray.destroy();
  expect(tray.create("", "").hasImage).toBe(false);
});
