import { expect, test } from "bun:test";
import appearance, {
  type AppearancePreferences,
} from "@bunaway/plugin-appearance";
import { NativeRegistry } from "@bunaway/protocol";
import { windowsAppearanceOperations } from "#plugins/appearance/src/operations";
import { createAccessibilityStateReader } from "#plugins/appearance/src/platforms/windows-accessibility";
import { createAppearanceController } from "#plugins/appearance/src/platforms/windows-controller";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("appearance", windowsAppearanceOperations);
const registry = new NativeRegistry([
  appearance._definition,
]);
const snapshot: AppearancePreferences = {
  appsTheme: null,
  systemTheme: null,
  accentColor: "#123456",
  highContrast: false,
  forcedColors: false,
  invertedColors: false,
  reducedMotion: false,
  transparencyEnabled: null,
  screenReaderEnabled: false,
  colors: {
    window: "#ffffff",
    windowText: "#000000",
    highlight: "#123456",
    highlightText: "#ffffff",
  },
};
const call = {
  operation: "appearance.getAccessibilityState",
  payload: null,
};

test("accessibility state contract is strict, Windows-only and independently granted", async () => {
  await expect(parsers.validateCall(call)).resolves.toMatchObject({
    payload: null,
  });
  await expect(
    parsers.validateCall({
      ...call,
      payload: {},
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  const state = {
    screenReaderEnabled: true,
    assistiveTechnologyActive: false,
  };
  expect(
    await parsers.validateOutput("appearance.getAccessibilityState", state),
  ).toEqual(state);
  for (const value of [
    {
      screenReaderEnabled: true,
    },
    {
      ...state,
      assistiveTechnologyActive: "yes",
    },
    {
      ...state,
      extra: true,
    },
  ]) {
    await expect(
      parsers.validateOutput("appearance.getAccessibilityState", value),
    ).rejects.toMatchObject({
      code: "INTERNAL",
    });
  }
  expect(appearance._definition.nativePlatforms.windows?.operations).toContain(
    "getAccessibilityState",
  );
  expect(
    appearance._definition.nativePlatforms.macos?.operations,
  ).not.toContain("getAccessibilityState");
  expect(
    registry.allowed(
      {
        permissions: [
          "appearance.getPreferences",
        ],
      },
      call,
    ),
  ).toBe(false);
  expect(
    registry.allowed(
      {
        permissions: [
          "appearance.getAccessibilityState",
        ],
      },
      call,
    ),
  ).toBe(true);
});

test("accessibility state is limited to trusted backend calls and a live adapter", () => {
  const state = {
    screenReaderEnabled: false,
    assistiveTechnologyActive: true,
  };
  const controller = createAppearanceController({
    read: () => snapshot,
    readAccessibilityState: () => state,
    dispose() {},
  });
  try {
    expect(() =>
      windowsAppearanceOperations.getAccessibilityState.handler(null, {
        instance: controller,
        source: "untrusted-view",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "PERMISSION_DENIED",
      }),
    );
    expect(
      windowsAppearanceOperations.getAccessibilityState.handler(null, {
        instance: controller,
        source: "backend",
      }),
    ).toEqual(state);
  } finally {
    controller.dispose();
  }
  expect(() => controller.getAccessibilityState()).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
});

test("UI Automation probe loads lazily, maps load failure to UNSUPPORTED and closes once", () => {
  let loads = 0;
  let closes = 0;
  let listening = false;
  let screenReader = false;
  const reader = createAccessibilityStateReader({
    screenReaderEnabled: () => screenReader,
    loadProbe() {
      loads++;
      return {
        clientsAreListening: () => listening,
        close() {
          closes++;
        },
      };
    },
  });
  expect(loads).toBe(0);
  expect(reader.read()).toEqual({
    screenReaderEnabled: false,
    assistiveTechnologyActive: false,
  });
  // The flag and the live client probe vary independently.
  listening = true;
  expect(reader.read()).toEqual({
    screenReaderEnabled: false,
    assistiveTechnologyActive: true,
  });
  screenReader = true;
  listening = false;
  expect(reader.read()).toEqual({
    screenReaderEnabled: true,
    assistiveTechnologyActive: false,
  });
  expect(loads).toBe(1);
  reader.dispose();
  reader.dispose();
  expect(closes).toBe(1);
  expect(() => reader.read()).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );

  const unavailable = createAccessibilityStateReader({
    screenReaderEnabled: () => true,
    loadProbe() {
      throw new Error("uiautomationcore.dll is missing");
    },
  });
  expect(() => unavailable.read()).toThrow(
    expect.objectContaining({
      code: "UNSUPPORTED",
    }),
  );
  // Disposing a reader that never loaded the probe releases nothing.
  unavailable.dispose();
});

test("readers without a UI Automation probe report UNSUPPORTED only for this query", () => {
  const controller = createAppearanceController({
    read: () => snapshot,
    dispose() {},
  });
  try {
    expect(() => controller.getAccessibilityState()).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED",
      }),
    );
  } finally {
    controller.dispose();
  }
});
