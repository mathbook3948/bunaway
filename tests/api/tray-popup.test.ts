import { expect, test } from "bun:test";
import type { NativeTrayServices } from "@bunaway/plugin-api/native";
import { BunawayError, type JsonValue } from "@bunaway/protocol";
import createOperationsDefinition from "#plugins/tray/src/index";
import { nativeFactory as createOperationsFactory } from "../fixtures/native-platform.ts";

const createOperations = createOperationsFactory(
  createOperationsDefinition,
  "windows",
);

function services(
  popUpContextMenu: NativeTrayServices["popUpContextMenu"],
): NativeTrayServices {
  return {
    get: () => null,
    getBounds: () => null,
    setTooltip: () => {},
    setIcon: () => {},
    setClickBehavior: () => {},
    focus: () => true,
    popUpContextMenu,
    subscribe: () => () => {},
    emit: () => {},
  };
}

function invoke(
  tray: NativeTrayServices,
  payload: JsonValue,
  signal?: AbortSignal,
) {
  const adapter = createOperations({
    dataRoot: "unused",
    capabilities: [],
    tray,
  });
  if (!adapter?.executeUI) {
    throw new Error("Missing UI adapter.");
  }
  return adapter.executeUI("tray.popUpContextMenu", payload, "backend", {
    requestId: "popup",
    permissions: {
      permissions: [
        "tray.popUpContextMenu",
      ],
    },
    ...(signal
      ? {
          signal,
        }
      : {}),
  });
}

test("tray popup input is strict and a missing position means the pointer", async () => {
  const calls: unknown[] = [];
  const tray = services((position) => {
    calls.push(position);
  });
  for (const input of [
    null,
    {
      position: null,
    },
    {
      position: {
        x: 1.5,
        y: 0,
      },
    },
    {
      position: {
        x: 0,
        y: 0,
        z: 0,
      },
    },
    {
      x: 0,
      y: 0,
    },
  ] as JsonValue[]) {
    await expect(invoke(tray, input)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  expect(calls).toEqual([]);

  expect(await invoke(tray, {})).toBeNull();
  expect(
    await invoke(tray, {
      position: {
        x: -1920,
        y: 40,
      },
    }),
  ).toBeNull();
  expect(calls).toEqual([
    null,
    {
      x: -1920,
      y: 40,
    },
  ]);
});

test("tray popup passes the request signal and surfaces native failures", async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  const tray = services((_position, signal) => {
    received = signal;
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "No menu is attached to the tray.",
    });
  });
  await expect(invoke(tray, {}, controller.signal)).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(received).toBeDefined();
  controller.abort();
  expect(received?.aborted).toBe(true);
});

test("tray popup is unsupported without tray services", async () => {
  const adapter = createOperations({
    dataRoot: "unused",
    capabilities: [],
  });
  await expect(
    adapter?.executeUI?.("tray.popUpContextMenu", {}, "backend", {
      requestId: "popup",
      permissions: {
        permissions: [
          "tray.popUpContextMenu",
        ],
      },
    }),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
});
