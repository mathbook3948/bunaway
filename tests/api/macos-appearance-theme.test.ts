import { expect, test } from "bun:test";
import type { ThemePreference, ThemeState } from "@bunaway/plugin-appearance";
import { macosAppearanceOperations } from "#plugins/appearance/src/operations";

function fakeInstance() {
  const calls: ThemePreference[] = [];
  const state = (preference: ThemePreference): ThemeState => ({
    preference,
    override: null,
    effectiveTheme: preference === "dark" ? "dark" : "light",
    highContrast: false,
  });
  return {
    calls,
    instance: {
      read() {
        throw new Error("not used");
      },
      getTheme: () => state(calls.at(-1) ?? "system"),
      setTheme(theme: ThemePreference) {
        calls.push(theme);
        return state(theme);
      },
      dispose() {},
    },
  };
}

test("macOS app theme control requires a trusted backend call", () => {
  const { instance, calls } = fakeInstance();
  for (const source of [
    "untrusted-view",
    "view",
  ] as const) {
    expect(() =>
      macosAppearanceOperations.setTheme.handler(
        {
          windowId: null,
          theme: "dark",
        },
        {
          instance,
          source,
        },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "PERMISSION_DENIED",
      }),
    );
    expect(() =>
      macosAppearanceOperations.getTheme.handler(
        {
          windowId: null,
        },
        {
          instance,
          source,
        },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "PERMISSION_DENIED",
      }),
    );
  }
  expect(calls).toEqual([]);
});

test("macOS sets and reads the app-wide theme", () => {
  const { instance, calls } = fakeInstance();
  expect(
    macosAppearanceOperations.setTheme.handler(
      {
        windowId: null,
        theme: "dark",
      },
      {
        instance,
        source: "backend",
      },
    ),
  ).toEqual({
    preference: "dark",
    override: null,
    effectiveTheme: "dark",
    highContrast: false,
  });
  expect(
    macosAppearanceOperations.getTheme.handler(
      {
        windowId: null,
      },
      {
        instance,
        source: "backend",
      },
    ),
  ).toMatchObject({
    preference: "dark",
  });
  expect(calls).toEqual([
    "dark",
  ]);
});

test("macOS rejects window IDs as UNSUPPORTED and a cleared app theme as INVALID_ARGUMENT", () => {
  const { instance, calls } = fakeInstance();
  const context = {
    instance,
    source: "backend" as const,
  };
  expect(() =>
    macosAppearanceOperations.setTheme.handler(
      {
        windowId: "window-1",
        theme: "dark",
      },
      context,
    ),
  ).toThrow(
    expect.objectContaining({
      code: "UNSUPPORTED",
    }),
  );
  expect(() =>
    macosAppearanceOperations.getTheme.handler(
      {
        windowId: "window-1",
      },
      context,
    ),
  ).toThrow(
    expect.objectContaining({
      code: "UNSUPPORTED",
    }),
  );
  expect(() =>
    macosAppearanceOperations.setTheme.handler(
      {
        windowId: null,
        theme: null,
      },
      context,
    ),
  ).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
  expect(calls).toEqual([]);
});
