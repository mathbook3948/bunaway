import { expect, test } from "bun:test";
import type {
  NativeTrayEvent,
  NativeTrayInitialization,
  NativeTrayServices,
} from "@bunaway/plugin-api/native";
import type { JsonValue } from "@bunaway/protocol";
import {
  type BalloonTrayOwner,
  dispose,
  initializeWith,
} from "#plugins/tray/src/platforms/windows";

type HoverCallback = NonNullable<
  Parameters<Parameters<typeof initializeWith>[1]>[5]
>;

function harness() {
  const emitted: {
    name: string;
    payload: JsonValue;
  }[] = [];
  let listener: ((event: NativeTrayEvent) => void) | undefined;
  let hover: HoverCallback | undefined;
  const owner: BalloonTrayOwner = {
    displayBalloon: () => {},
    removeBalloon: () => {},
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
  };
  const services: NativeTrayServices = {
    initialize(create) {
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
    },
    get: owner.get,
    getBounds: owner.getBounds,
    setTooltip: owner.setTooltip,
    setIcon: owner.setIcon,
    setClickBehavior: owner.setClickBehavior,
    setVisible: owner.setVisible,
    focus: owner.focus,
    popUpContextMenu: owner.popUpContextMenu,
    subscribe(receive) {
      listener = receive;
      return () => {
        listener = undefined;
      };
    },
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
      hover = args[5];
      return owner;
    },
  );
  return {
    state,
    emitted,
    hover: () => hover,
    click: (event: NativeTrayEvent) => listener?.(event),
  };
}

test("tray.hover is emitted once per hover callback and stops after plugin dispose", () => {
  const h = harness();
  const hover = h.hover();
  if (!hover) {
    throw new Error("The tray factory did not receive a hover callback.");
  }
  hover({
    state: "enter",
    position: {
      x: 1,
      y: 2,
    },
  });
  expect(h.emitted).toEqual([
    {
      name: "tray.hover",
      payload: {
        state: "enter",
        position: {
          x: 1,
          y: 2,
        },
      },
    },
  ]);
  // Click input keeps its own event name and is unaffected by hover wiring.
  h.click({
    id: "main",
    button: "left",
    state: "up",
    position: null,
  });
  expect(h.emitted.map((event) => event.name)).toEqual([
    "tray.hover",
    "tray.input",
  ]);

  dispose(h.state);
  hover({
    state: "leave",
    position: null,
  });
  expect(h.emitted.map((event) => event.name)).toEqual([
    "tray.hover",
    "tray.input",
  ]);
});
