import { expect, test } from "bun:test";
import type { CommandContext } from "@bunaway/plugin-api";
import { bindCommandHost } from "@bunaway/plugin-api/host";
import appearance, {
  type AppearancePreferences,
} from "@bunaway/plugin-appearance";
import { type HostContext, NativeRegistry } from "@bunaway/protocol";
import { bindHostAPI } from "#core/host-api";
import { appearanceOperations } from "#plugins/appearance/src/operations";
import {
  booleanPreference,
  colorRef,
} from "#plugins/appearance/src/platforms/windows";
import { testAppInfo } from "../fixtures/app-info.ts";
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
  appearance._definition,
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
    app: testAppInfo,
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

test("frame theme contracts are additive, independently granted and Windows-only", async () => {
  const { windowsAppearanceOperations } = await import(
    "#plugins/appearance/src/operations"
  );
  const parser = pluginParsers("appearance", windowsAppearanceOperations);
  for (const theme of [
    "system",
    "light",
    "dark",
    null,
  ]) {
    await expect(
      parser.validateCall({
        operation: "appearance.setTheme",
        payload: {
          windowId: "window-1",
          theme,
        },
      }),
    ).resolves.toMatchObject({
      payload: {
        theme,
      },
    });
  }
  for (const payload of [
    {
      theme: "dark",
    },
    {
      windowId: null,
      theme: "auto",
    },
    {
      windowId: "",
      theme: "light",
    },
    {
      windowId: null,
      theme: "dark",
      global: true,
    },
  ]) {
    await expect(
      parser.validateCall({
        operation: "appearance.setTheme",
        payload,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  expect(appearance._definition.nativePlatforms.windows?.operations).toContain(
    "setTheme",
  );
  expect(
    appearance._definition.nativePlatforms.macos?.operations,
  ).not.toContain("setTheme");
  expect(
    registry.allowed(
      {
        permissions: [
          "appearance.getPreferences",
        ],
      },
      {
        operation: "appearance.setTheme",
        payload: {
          windowId: null,
          theme: "dark",
        },
      },
    ),
  ).toBe(false);
  expect(
    registry.allowed(
      {
        permissions: [
          "appearance.setTheme",
        ],
      },
      {
        operation: "appearance.setTheme",
        payload: {
          windowId: null,
          theme: "dark",
        },
      },
    ),
  ).toBe(true);
  let changes = 0;
  const { createAppearanceController } = await import(
    "#plugins/appearance/src/platforms/windows-controller"
  );
  const controller = createAppearanceController(
    {
      read: () => snapshot,
      dispose() {},
    },
    {
      appearance: {
        subscribe(receive) {
          const release = receive({
            windowId: "window-1",
            setDark() {
              changes++;
            },
          });
          return release;
        },
      },
    },
  );
  try {
    expect(() =>
      windowsAppearanceOperations.setTheme.handler(
        {
          windowId: "window-1",
          theme: "dark",
        },
        {
          instance: controller,
          source: "untrusted-view",
        },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "PERMISSION_DENIED",
      }),
    );
    expect(changes).toBe(1);
    expect(
      windowsAppearanceOperations.setTheme.handler(
        {
          windowId: "window-1",
          theme: "dark",
        },
        {
          instance: controller,
          source: "backend",
        },
      ),
    ).toMatchObject({
      preference: "dark",
      override: "dark",
      highContrast: true,
      effectiveTheme: null,
    });
  } finally {
    controller.dispose();
  }
});

test("appearance events require a live route and the preference read grant", async () => {
  const { publishSystemEvent } = await import(
    "#native/windows/bun/system-events"
  );
  const recipients = [
    {
      policy: {
        host: {
          permissions: [
            "appearance.getPreferences",
          ],
        },
      },
      eventRoute: () => ({}),
    },
    {
      policy: {
        host: {
          permissions: [],
        },
      },
      eventRoute: () => ({}),
    },
    {
      policy: {
        host: {
          permissions: [
            "appearance.getPreferences",
          ],
        },
      },
      eventRoute: () => null,
    },
  ];
  const delivered: unknown[] = [];
  publishSystemEvent(
    registry,
    recipients,
    "appearance.changed",
    snapshot,
    "appearance.getPreferences",
    (recipient, event, payload) =>
      delivered.push([
        recipient,
        event,
        payload,
      ]),
  );
  expect(delivered).toEqual([
    [
      recipients[0],
      "appearance.changed",
      snapshot,
    ],
  ]);
});
