import { expect, test } from "bun:test";
import type { CommandContext } from "@bunaway/plugin-api";
import { bindCommandHost } from "@bunaway/plugin-api/host";
import {
  type AppearancePreferences,
  appearance,
  appearancePlugin,
} from "@bunaway/plugin-appearance";
import { type HostContext, NativeRegistry } from "@bunaway/protocol";
import { bindHostAPI } from "#core/host-api";
import { appearanceOperations } from "#plugins/appearance/src/operations";
import {
  booleanPreference,
  colorRef,
} from "#plugins/appearance/src/preferences";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const snapshot: AppearancePreferences = {
  appsTheme: null,
  systemTheme: "dark",
  accentColor: "#123456",
  highContrast: true,
  forcedColors: true,
  reducedMotion: false,
  transparencyEnabled: null,
  screenReaderEnabled: false,
  colors: {
    window: "#000000",
    windowText: "#ffffff",
    highlight: "#123456",
    highlightText: "#ffffff",
  },
};
const parsers = pluginParsers("appearance", appearanceOperations);
const registry = new NativeRegistry([
  appearancePlugin,
]);

test("appearance validates strict input and preserves unknown theme/transparency values", async () => {
  await expect(
    parsers.validateCall({
      operation: "appearance.getPreferences",
      payload: null,
    }),
  ).resolves.toMatchObject({
    payload: null,
  });
  await expect(
    parsers.validateCall({
      operation: "appearance.getPreferences",
      payload: {},
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(
    await parsers.validateOutput("appearance.getPreferences", snapshot),
  ).toEqual(snapshot);
  for (const value of [
    {
      ...snapshot,
      appsTheme: "system",
    },
    {
      ...snapshot,
      accentColor: "red",
    },
    {
      ...snapshot,
      colors: {},
    },
  ]) {
    await expect(
      parsers.validateOutput("appearance.getPreferences", value),
    ).rejects.toMatchObject({
      code: "INTERNAL",
    });
  }
  expect(booleanPreference(0)).toBe(false);
  expect(booleanPreference(1)).toBe(true);
  expect(booleanPreference(null)).toBeNull();
  expect(booleanPreference(2)).toBeNull();
  expect(colorRef(0x00ab3412)).toBe("#1234ab");
  expect(
    registry.allowed(
      {
        permissions: [],
      },
      {
        operation: "appearance.getPreferences",
        payload: null,
      },
    ),
  ).toBe(false);
  expect(
    registry.allowed(
      {
        permissions: [
          "appearance.getPreferences",
        ],
      },
      {
        operation: "appearance.getPreferences",
        payload: null,
      },
    ),
  ).toBe(true);
});

test("appearance helper preserves source context, response and native denial", async () => {
  let calls = 0;
  const controller = new AbortController();
  const host = bindHostAPI(
    "appearance-view" as HostContext,
    controller.signal,
    async (context, call) => {
      expect(context).toBe("appearance-view" as HostContext);
      expect(call).toEqual({
        operation: "appearance.getPreferences",
        payload: null,
      });
      if (++calls === 1) {
        return {
          kind: "result",
          payload: snapshot,
        };
      }
      return {
        kind: "error",
        error: {
          code: "PERMISSION_DENIED",
          message: "Denied",
        },
      };
    },
    registry,
  );
  const command = bindCommandHost({
    input: {
      const: null,
    },
    output: {
      const: null,
    },
    async run(_input: unknown, _context: CommandContext) {
      expect(await appearance.getPreferences()).toEqual(snapshot);
      await expect(appearance.getPreferences()).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      return null;
    },
  });
  await command.run(null, {
    host,
    signal: controller.signal,
    state: {
      get: () => undefined,
      set() {},
      delete: () => false,
    },
    events: {
      emit: async () => {},
    },
  });
  expect(calls).toBe(2);
});
