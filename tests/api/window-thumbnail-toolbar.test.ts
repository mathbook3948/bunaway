import { expect, test } from "bun:test";
import type {
  NativeThumbnailButton,
  NativeWindow,
  NativeWindowServices,
} from "@bunaway/plugin-api/native";
import windows, {
  validateWindowCall,
  validateWindowOutput,
  windowEvents,
} from "@bunaway/plugin-windows";
import { type JsonValue, validateValue } from "@bunaway/protocol";
import {
  pressedThumbnailButton,
  thumbnailSlots,
  thumbnailToolbarOf,
} from "#native/windows/bun/thumbnail-toolbar";
import { createOperations } from "#plugins/windows/src/platforms/windows";
import { trayIco } from "../fixtures/tray-icon.ts";

const operation = "windows.setThumbnailToolbar";
const target = {
  view: "main",
};
const ico = trayIco().toString("base64");
const identity = {
  windowId: "window-1",
  viewId: "main",
};

function button(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    ico,
    ...extra,
  };
}

function nativeButton(
  id: string,
  overrides: Partial<NativeThumbnailButton> = {},
): NativeThumbnailButton {
  return {
    id,
    icon: () => 1n,
    tooltip: id,
    flags: [],
    ...overrides,
  };
}

test("toolbar schema takes up to seven uniquely named buttons with defaults", () => {
  const parsed = validateWindowCall({
    operation,
    payload: {
      ...target,
      buttons: [
        button("prev"),
        button("play", {
          tooltip: "Play",
          flags: [
            "dismissonclick",
            "nobackground",
          ],
        }),
      ],
    },
  });
  expect(parsed.payload).toEqual({
    ...target,
    buttons: [
      {
        id: "prev",
        ico,
        tooltip: "",
        flags: [],
      },
      {
        id: "play",
        ico,
        tooltip: "Play",
        flags: [
          "dismissonclick",
          "nobackground",
        ],
      },
    ],
  });
  for (const payload of [
    {
      ...target,
      buttons: [],
    },
    {
      ...target,
      windowId: "id-1",
      buttons: Array.from(
        {
          length: 7,
        },
        (_, index) => button(`b${index}`),
      ),
    },
    {
      ...target,
      buttons: [
        button("t", {
          tooltip: "a".repeat(259),
        }),
      ],
    },
  ]) {
    expect(() =>
      validateWindowCall({
        operation,
        payload,
      }),
    ).not.toThrow();
  }
});

test("toolbar schema rejects bad counts, ids, tooltips, flags and images", () => {
  for (const buttons of [
    Array.from(
      {
        length: 8,
      },
      (_, index) => button(`b${index}`),
    ),
    [
      button("same"),
      button("same"),
    ],
    [
      button(""),
    ],
    [
      button("-leading"),
    ],
    [
      button("a".repeat(65)),
    ],
    [
      button("has space"),
    ],
    [
      button("t", {
        tooltip: "a".repeat(260),
      }),
    ],
    [
      button("t", {
        tooltip: "a\0b",
      }),
    ],
    [
      button("f", {
        flags: [
          "enabled",
          "disabled",
        ],
      }),
    ],
    [
      button("f", {
        flags: [
          "hidden",
          "hidden",
        ],
      }),
    ],
    [
      button("f", {
        flags: [
          "unknown",
        ],
      }),
    ],
    [
      {
        id: "no-icon",
      },
    ],
    [
      button("bad", {
        ico: "AAAA",
      }),
    ],
    [
      button("extra", {
        extra: 1,
      }),
    ],
  ]) {
    expect(() =>
      validateWindowCall({
        operation,
        payload: {
          ...target,
          buttons,
        },
      }),
    ).toThrow();
  }
  expect(() =>
    validateWindowCall({
      operation,
      payload: target,
    }),
  ).toThrow();
  expect(validateWindowOutput(operation, null)).toBeNull();
  expect(() => validateWindowOutput(operation, true)).toThrow();
});

test("click event payload carries only the window identity and a registered-shape button id", () => {
  const schema = windowEvents["windows.thumbnailToolbarClicked"];
  expect(
    validateValue(schema, {
      ...identity,
      buttonId: "play-pause",
    }),
  ).toEqual({
    ...identity,
    buttonId: "play-pause",
  });
  for (const buttonId of [
    "",
    "has space",
    "a".repeat(65),
    1,
  ]) {
    expect(() =>
      validateValue(schema, {
        ...identity,
        buttonId,
      }),
    ).toThrow();
  }
  expect(() =>
    validateValue(schema, {
      ...identity,
      buttonId: "ok",
      slot: 0,
    }),
  ).toThrow();
});

test("the thumbnail toolbar is unsupported on macOS", () => {
  const names = windows._definition.nativePlatforms.macos?.operations ?? [];
  expect(names).not.toContain("setThumbnailToolbar");
});

function fixture(withToolbar = true) {
  const calls: unknown[][] = [];
  const unused = () => {
    throw new Error("Unexpected native window control");
  };
  const native = {
    getReadiness: unused,
    ...(withToolbar
      ? {
          setThumbnailToolbar: (...args: unknown[]) => calls.push(args),
        }
      : {}),
  } as unknown as NativeWindow;
  const services = {
    specs: [
      {
        view: "main",
        title: "Main",
        home: "https://app.bunaway.local",
        window: {
          width: 800,
          height: 600,
        },
      },
    ],
    read: () => ({
      closed: false,
      cleaned: false,
      ready: true,
      failure: null,
      deadline: Infinity,
    }),
    create: unused,
    close: unused,
    window: () => native,
    stopping: () => false,
    cancelled: () => false,
    now: Date.now,
    tick: async () => {},
  } as unknown as NativeWindowServices;
  const execute = createOperations({
    windows: services,
    dataRoot: ".",
    capabilities: [],
  }).executeUI;
  if (!execute) {
    throw new Error("Missing window UI adapter");
  }
  return {
    calls,
    invoke: (name: string, payload: JsonValue) =>
      execute(name, payload, "backend", {
        requestId: "toolbar",
        permissions: {
          permissions: [
            name,
          ],
        },
      }),
  };
}

test("toolbar dispatch hands the host one icon provider per button in order", async () => {
  const f = fixture();
  expect(
    await f.invoke(operation, {
      ...target,
      buttons: [
        button("prev", {
          tooltip: "Previous",
        }),
        button("next", {
          flags: [
            "disabled",
          ],
        }),
      ],
    }),
  ).toBeNull();
  await f.invoke(operation, {
    ...target,
    buttons: [],
  });
  const [first, second] = f.calls;
  expect(
    ((first ?? [])[0] as NativeThumbnailButton[]).map((entry) => ({
      id: entry.id,
      icon: typeof entry.icon,
      tooltip: entry.tooltip,
      flags: entry.flags,
    })),
  ).toEqual([
    {
      id: "prev",
      icon: "function",
      tooltip: "Previous",
      flags: [],
    },
    {
      id: "next",
      icon: "function",
      tooltip: "",
      flags: [
        "disabled",
      ],
    },
  ]);
  expect(second).toEqual([
    [],
  ]);
});

test("a window without a toolbar control reports UNSUPPORTED", async () => {
  const f = fixture(false);
  await expect(
    f.invoke(operation, {
      ...target,
      buttons: [],
    }),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
});

test("host validation rechecks what the plugin schema promises", () => {
  expect(() =>
    thumbnailToolbarOf(
      Array.from(
        {
          length: 8,
        },
        (_, index) => nativeButton(`b${index}`),
      ),
    ),
  ).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
  for (const buttons of [
    [
      nativeButton("a"),
      nativeButton("a"),
    ],
    [
      nativeButton("bad id"),
    ],
    [
      nativeButton("t", {
        tooltip: "x".repeat(260),
      }),
    ],
    [
      nativeButton("t", {
        tooltip: "a\0",
      }),
    ],
    [
      nativeButton("f", {
        flags: [
          "enabled",
          "disabled",
        ],
      }),
    ],
    [
      nativeButton("f", {
        flags: [
          "bogus" as never,
        ],
      }),
    ],
  ]) {
    expect(() => thumbnailToolbarOf(buttons)).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  }
});

test("slots keep the buttons first and hide the rest so Add runs once", () => {
  const buttons = [
    nativeButton("prev"),
    nativeButton("play", {
      flags: [
        "dismissonclick",
        "nobackground",
      ],
    }),
  ];
  const toolbar = thumbnailToolbarOf(buttons);
  const slots = thumbnailSlots(toolbar, buttons, [
    11n,
    12n,
  ]);
  expect(slots).toHaveLength(7);
  expect(slots.map((slot) => slot.id)).toEqual([
    0,
    1,
    2,
    3,
    4,
    5,
    6,
  ]);
  expect(slots[0]).toEqual({
    id: 0,
    icon: 11n,
    tooltip: "prev",
    flags: 0,
  });
  expect(slots[1]?.flags).toBe(0x2 | 0x4);
  for (const slot of slots.slice(2)) {
    expect(slot).toEqual({
      id: slot.id,
      tooltip: "",
      flags: 0x8,
    });
  }
  // An empty toolbar hides all seven slots.
  expect(
    thumbnailSlots(thumbnailToolbarOf([]), [], []).every(
      (slot) => slot.flags === 0x8 && slot.icon === undefined,
    ),
  ).toBe(true);
});

/** WM_COMMAND from a thumbnail button: THBN_CLICKED in the high word, the slot in the low word. */
function click(slot: number, notification = 0x1800): bigint {
  return BigInt((notification << 16) | slot);
}

test("a press maps to the app's id only for a usable registered slot", () => {
  const toolbar = thumbnailToolbarOf([
    nativeButton("prev"),
    nativeButton("off", {
      flags: [
        "disabled",
      ],
    }),
    nativeButton("gone", {
      flags: [
        "hidden",
      ],
    }),
    nativeButton("info", {
      flags: [
        "noninteractive",
      ],
    }),
    nativeButton("play", {
      flags: [
        "dismissonclick",
      ],
    }),
  ]);
  expect(pressedThumbnailButton(toolbar, click(0))).toBe("prev");
  expect(pressedThumbnailButton(toolbar, click(4))).toBe("play");
  // Unusable slots, slots past the list and slots past the shell's seven never reach the app.
  for (const slot of [
    1,
    2,
    3,
    5,
    6,
    7,
    0xffff,
  ]) {
    expect(pressedThumbnailButton(toolbar, click(slot))).toBeUndefined();
  }
  // Menu and accelerator commands (notification 0 or 1) are not button presses.
  expect(pressedThumbnailButton(toolbar, click(0, 0))).toBeUndefined();
  expect(pressedThumbnailButton(toolbar, click(0, 1))).toBeUndefined();
  // No toolbar was ever applied.
  expect(pressedThumbnailButton(undefined, click(0))).toBeUndefined();
});
