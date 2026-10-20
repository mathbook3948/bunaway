import { defineNativeOperation } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import { z } from "zod";
import {
  type AppearanceInstance,
  accessibilityStateSchema,
  preferencesSchema,
  themePreferenceSchema,
  themeStateSchema,
} from "#appearance/contract";

const operation = defineNativeOperation<AppearanceInstance>();
export const appearanceOperations = {
  getPreferences: operation({
    input: z.null(),
    output: preferencesSchema,
    handler: (_input, { instance }) => instance.read(),
  }),
};

const windowsOperation =
  defineNativeOperation<
    ReturnType<
      typeof import("#appearance/platforms/windows-controller").createAppearanceController
    >
  >();
const target = z.strictObject({
  windowId: z.string().min(1).max(128).nullable(),
});
/** App and cross-window frame control belongs to trusted backend calls, with independent grants. */
function backend(source: string) {
  if (source !== "backend") {
    throw new BunawayError({
      code: "PERMISSION_DENIED",
      message: "Frame appearance control requires a trusted backend call.",
    });
  }
}
export const windowsAppearanceOperations = {
  ...appearanceOperations,
  getAccessibilityState: windowsOperation({
    input: z.null(),
    output: accessibilityStateSchema,
    handler: (_input, { instance, source }) => {
      // Assistive technology use is sensitive, so views cannot read it directly.
      backend(source);
      return instance.getAccessibilityState();
    },
  }),
  getTheme: windowsOperation({
    input: target,
    output: themeStateSchema,
    handler: ({ windowId }, { instance, source }) => {
      backend(source);
      return instance.getTheme(windowId);
    },
  }),
  setTheme: windowsOperation({
    input: target.extend({
      theme: themePreferenceSchema.nullable(),
    }),
    output: themeStateSchema,
    handler: ({ windowId, theme }, { instance, source }) => {
      backend(source);
      return instance.setTheme(windowId, theme);
    },
  }),
};

const macosOperation =
  defineNativeOperation<
    ReturnType<typeof import("#appearance/platforms/macos").initialize>
  >();
/** macOS controls only the app-wide theme: a window ID is UNSUPPORTED and the app theme cannot be cleared. */
function requireAppScope(windowId: string | null) {
  if (windowId !== null) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "macOS supports only the app-wide theme (windowId: null).",
    });
  }
}
export const macosAppearanceOperations = {
  ...appearanceOperations,
  getTheme: macosOperation({
    input: target,
    output: themeStateSchema,
    handler: ({ windowId }, { instance, source }) => {
      backend(source);
      requireAppScope(windowId);
      return instance.getTheme();
    },
  }),
  setTheme: macosOperation({
    input: target.extend({
      theme: themePreferenceSchema.nullable(),
    }),
    output: themeStateSchema,
    handler: ({ windowId, theme }, { instance, source }) => {
      backend(source);
      requireAppScope(windowId);
      if (theme === null) {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "The app theme cannot be cleared; use system.",
        });
      }
      return instance.setTheme(theme);
    },
  }),
};
