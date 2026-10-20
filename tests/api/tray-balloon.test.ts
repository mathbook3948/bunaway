import { expect, test } from "bun:test";
import type {
  NativeTrayInitialization,
  NativeTrayServices,
} from "@bunaway/plugin-api/native";
import type { JsonValue } from "@bunaway/protocol";
import {
  MAX_TRAY_BALLOON_CONTENT_UNITS,
  MAX_TRAY_BALLOON_TITLE_UNITS,
  type TrayBalloon,
} from "#plugins/tray/src/contract";
import { trayOperations } from "#plugins/tray/src/operations";
import {
  type BalloonTrayOwner,
  displayBalloon,
  dispose,
  initializeWith,
  removeBalloon,
} from "#plugins/tray/src/platforms/windows";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

type BalloonCallback = NonNullable<
  Parameters<Parameters<typeof initializeWith>[1]>[6]
>;

function harness(options: { configured?: boolean } = {}) {
  const configured = options.configured ?? true;
  const emitted: {
    name: string;
    payload: JsonValue;
  }[] = [];
  const shown: (TrayBalloon | "removed")[] = [];
  let balloon: BalloonCallback | undefined;
  const owner: BalloonTrayOwner = {
    hwnd: 1n,
    get: () => null,
    getBounds: () => null,
    setTooltip: () => {},
    setIcon: () => {},
    setClickBehavior: () => {},
    setVisible: () => {},
    focus: () => true,
    popUpContextMenu: () => {},
    setMenu: () => {},
    dispose: () => {},
    displayBalloon: (request) => {
      shown.push(request);
    },
    removeBalloon: () => {
      shown.push("removed");
    },
  };
  const services: NativeTrayServices = {
    initialize(create) {
      if (configured) {
        create({
          windows: {
            icon: undefined,
            create: () => 1n,
            destroy: () => {},
          },
          tooltip: "",
          receive: () => {},
          notify: () => {},
          retain: () => {},
        } satisfies NativeTrayInitialization);
      }
    },
    get: owner.get,
    getBounds: owner.getBounds,
    setTooltip: owner.setTooltip,
    setIcon: owner.setIcon,
    setClickBehavior: owner.setClickBehavior,
    setVisible: owner.setVisible,
    focus: owner.focus,
    popUpContextMenu: owner.popUpContextMenu,
    subscribe: () => () => {},
    emit: (name, payload) =>
      emitted.push({
        name,
        payload,
      }),
  };
  const state = initializeWith(
    {
      dataRoot: "unused",
      capabilities: [],
      tray: services,
    },
    (...args) => {
      balloon = args[6];
      return owner;
    },
  );
  return {
    state,
    emitted,
    shown,
    balloon: () => balloon,
  };
}

const request = {
  title: "Done",
  content: "Backup finished",
  iconType: "info",
  silent: true,
} as const;

test("balloon inputs are strict and bounded by the NOTIFYICONDATAW buffers", async () => {
  const parsers = pluginParsers("tray", trayOperations);
  expect(MAX_TRAY_BALLOON_TITLE_UNITS).toBe(63);
  expect(MAX_TRAY_BALLOON_CONTENT_UNITS).toBe(255);
  for (const payload of [
    {
      title: "",
      content: "x",
    },
    request,
    {
      title: "😀".repeat(31),
      content: "😀".repeat(127),
    },
    {
      title: "t".repeat(MAX_TRAY_BALLOON_TITLE_UNITS),
      content: "c".repeat(MAX_TRAY_BALLOON_CONTENT_UNITS),
      iconType: "error",
    },
  ]) {
    await parsers.validateCall({
      operation: "tray.displayBalloon",
      payload,
    });
  }
  for (const payload of [
    {
      title: "t",
    },
    {
      content: "c",
    },
    {
      title: "t",
      content: "",
    },
    {
      title: "t".repeat(MAX_TRAY_BALLOON_TITLE_UNITS + 1),
      content: "c",
    },
    {
      title: "t",
      content: "c".repeat(MAX_TRAY_BALLOON_CONTENT_UNITS + 1),
    },
    {
      title: "😀".repeat(32),
      content: "c",
    },
    {
      title: "a\0b",
      content: "c",
    },
    {
      title: "t",
      content: "\ud800",
    },
    {
      title: "t",
      content: "c",
      iconType: "custom",
    },
    {
      title: "t",
      content: "c",
      silent: "yes",
    },
    {
      title: "t",
      content: "c",
      icon: "AAAA",
    },
  ]) {
    await expect(
      parsers.validateCall({
        operation: "tray.displayBalloon",
        payload,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  await parsers.validateCall({
    operation: "tray.removeBalloon",
    payload: null,
  });
  await expect(
    parsers.validateCall({
      operation: "tray.removeBalloon",
      payload: {},
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});

test("balloon defaults resolve to no icon and an audible notification", async () => {
  const parsed = trayOperations.displayBalloon.input.parse({
    title: "t",
    content: "c",
  });
  expect(parsed).toEqual({
    title: "t",
    content: "c",
    iconType: "none",
    silent: false,
  });
});

test("displayBalloon and removeBalloon reach the retained tray owner", () => {
  const h = harness();
  expect(displayBalloon(h.state, request)).toBeNull();
  expect(removeBalloon(h.state)).toBeNull();
  expect(h.shown).toEqual([
    request,
    "removed",
  ]);
});

test("balloon controls fail with UNSUPPORTED when no tray was created", () => {
  const h = harness({
    configured: false,
  });
  for (const call of [
    () => displayBalloon(h.state, request),
    () => removeBalloon(h.state),
  ]) {
    expect(call).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED",
      }),
    );
  }
});

test("tray.balloon forwards each shell state and stops after plugin dispose", () => {
  const h = harness();
  const balloon = h.balloon();
  if (!balloon) {
    throw new Error("The tray factory did not receive a balloon callback.");
  }
  for (const state of [
    "show",
    "click",
    "closed",
  ] as const) {
    balloon({
      state,
    });
  }
  expect(h.emitted).toEqual([
    {
      name: "tray.balloon",
      payload: {
        state: "show",
      },
    },
    {
      name: "tray.balloon",
      payload: {
        state: "click",
      },
    },
    {
      name: "tray.balloon",
      payload: {
        state: "closed",
      },
    },
  ]);
  dispose(h.state);
  balloon({
    state: "show",
  });
  expect(h.emitted).toHaveLength(3);
});
