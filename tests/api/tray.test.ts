import { expect, test } from "bun:test";
import type {
  NativeTrayEvent,
  NativeTrayServices,
} from "@bunaway/plugin-api/native";
import {
  MAX_TRAY_ICO_BYTES,
  MAX_TRAY_TOOLTIP_UNITS,
} from "@bunaway/plugin-api/native";
import tray from "@bunaway/plugin-tray";
import { type JsonValue, NativeRegistry } from "@bunaway/protocol";
import createOperationsDefinition from "#plugins/tray/src/index";
import { trayOperations } from "#plugins/tray/src/operations";
import { trayIconImage } from "#plugins/tray/src/platforms/windows-icon-data";
import { nativeFactory as createOperationsFactory } from "../fixtures/native-platform.ts";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";
import { trayIco, trayPngIco } from "../fixtures/tray-icon.ts";

const createOperations = createOperationsFactory(
  createOperationsDefinition,
  "windows",
);

test("tray inputs are strict, bounded and grant each operation independently", async () => {
  const parsers = pluginParsers("tray", trayOperations);
  expect([
    ...new NativeRegistry([
      tray._definition,
    ]).operations.keys(),
  ]).toEqual(Object.keys(trayOperations).map((name) => `tray.${name}`));
  for (const tooltip of [
    "",
    "한글 😀",
    "x".repeat(MAX_TRAY_TOOLTIP_UNITS),
  ]) {
    await parsers.validateCall({
      operation: "tray.setTooltip",
      payload: {
        tooltip,
      },
    });
  }
  for (const tooltip of [
    "x".repeat(MAX_TRAY_TOOLTIP_UNITS + 1),
    "a\0b",
    "\ud800",
    "😀".repeat(64),
  ]) {
    await expect(
      parsers.validateCall({
        operation: "tray.setTooltip",
        payload: {
          tooltip,
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  for (const ico of [
    "not base64!",
    "C:/icon.ico",
    "AAAA\n",
    "A".repeat(Math.ceil(MAX_TRAY_ICO_BYTES / 3) * 4 + 4),
  ]) {
    await expect(
      parsers.validateCall({
        operation: "tray.setIcon",
        payload: {
          ico,
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  await parsers.validateCall({
    operation: "tray.setIcon",
    payload: {
      ico: null,
    },
  });
  await parsers.validateCall({
    operation: "tray.setIcon",
    payload: {
      ico: trayIco().toString("base64"),
    },
  });
});

test("ICO decoding rejects invalid directories and decoded allocation before native calls", () => {
  const valid = trayIco();
  expect(trayIconImage(valid.toString("base64"))).toEqual(valid.subarray(22));
  const png = trayPngIco();
  expect(trayIconImage(png.toString("base64"))).toEqual(png.subarray(22));
  const hugePng = Buffer.from(png);
  hugePng.writeUInt32BE(100000, 38);
  expect(() => trayIconImage(hugePng.toString("base64"))).toThrow();
  for (const mutate of [
    (data: Buffer) => data.writeUInt16LE(2, 2),
    (data: Buffer) => data.writeUInt16LE(33, 4),
    (data: Buffer) => data.writeUInt32LE(4, 18),
    (data: Buffer) => data.writeUInt32LE(0xffffffff, 14),
    (data: Buffer) => data.writeInt32LE(100000, 26),
    (data: Buffer) => data.writeUInt32LE(3, 38),
  ]) {
    const malformed = Buffer.from(valid);
    mutate(malformed);
    expect(() => trayIconImage(malformed.toString("base64"))).toThrow();
  }
  expect(() =>
    trayIconImage(valid.subarray(0, valid.length - 1).toString("base64")),
  ).toThrow();
  expect(() =>
    trayIconImage(Buffer.alloc(MAX_TRAY_ICO_BYTES + 1).toString("base64")),
  ).toThrow();
});

test("tray notifications and controls keep ownership in host services and cancel waits on disposal", async () => {
  const events: JsonValue[] = [];
  let receive: ((event: NativeTrayEvent) => void) | undefined;
  let unsubscribed = false;
  let state = {
    id: "main" as const,
    tooltip: "Initial",
    icon: "app" as "app" | "custom",
    showOnLeftClick: true,
    menuOnRightClick: true,
  };
  const services: NativeTrayServices = {
    get: () => ({
      ...state,
    }),
    getBounds: () => null,
    setTooltip(tooltip) {
      state = {
        ...state,
        tooltip,
      };
    },
    setIcon(ico) {
      state = {
        ...state,
        icon: ico === null ? "app" : "custom",
      };
    },
    setClickBehavior(showOnLeftClick, menuOnRightClick) {
      state = {
        ...state,
        showOnLeftClick,
        menuOnRightClick,
      };
    },
    focus: () => true,
    subscribe(listener) {
      receive = listener;
      return () => {
        unsubscribed = true;
        receive = undefined;
      };
    },
    emit(name, payload) {
      expect(name).toBe("tray.input");
      events.push(payload);
    },
  };
  const adapter = createOperations({
    dataRoot: "unused",
    capabilities: [],
    tray: services,
  });
  if (!adapter) {
    throw new Error("Missing validated adapter");
  }
  const invoke = async (
    name: keyof typeof trayOperations,
    payload: JsonValue,
    permissions = [
      `tray.${name}`,
    ],
    signal?: AbortSignal,
  ) => {
    if (!adapter.executeUI) {
      throw new Error("Missing UI adapter.");
    }
    return adapter.executeUI(`tray.${name}`, payload, "backend", {
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
  await expect(
    invoke(
      "setTooltip",
      {
        tooltip: "Denied",
      },
      [
        "tray.get",
      ],
    ),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  await invoke("setTooltip", {
    tooltip: "Changed",
  });
  await invoke("setClickBehavior", {
    showOnLeftClick: false,
    menuOnRightClick: false,
  });
  await invoke("setIcon", {
    ico: trayIco().toString("base64"),
  });
  expect(await invoke("get", null)).toMatchObject({
    tooltip: "Changed",
    icon: "custom",
    showOnLeftClick: false,
    menuOnRightClick: false,
  });
  await invoke("setIcon", {
    ico: null,
  });
  expect(await invoke("focus", null)).toBe(true);
  const waiting = invoke("waitForEvent", null);
  // Parsing is asynchronous; let the owning adapter install the wait before native input.
  await Bun.sleep(0);
  const event: NativeTrayEvent = {
    id: "main",
    button: "middle",
    state: "up",
    position: {
      x: -20,
      y: 40,
    },
  };
  receive?.(event);
  expect(await waiting).toEqual(event);
  expect(events).toEqual([
    event,
  ]);
  const cancellation = new AbortController();
  const cancelled = invoke(
    "waitForEvent",
    null,
    [
      "tray.waitForEvent",
    ],
    cancellation.signal,
  );
  cancellation.abort();
  await expect(cancelled).rejects.toMatchObject({
    code: "CANCELLED",
  });
  const pending = invoke("waitForEvent", null);
  const settled = Promise.allSettled([
    pending,
  ]);
  await adapter.dispose();
  await adapter.dispose();
  expect(unsubscribed).toBe(true);
  expect(await settled).toMatchObject([
    {
      status: "rejected",
      reason: {
        code: "CANCELLED",
      },
    },
  ]);
});
