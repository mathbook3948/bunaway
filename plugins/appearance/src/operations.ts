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
const themeChange = z.strictObject({
  theme: themePreferenceSchema.nullable(),
});
/** App and window frame control belongs to trusted backend calls, with independent grants. */
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
    input: z.null(),
    output: themeStateSchema,
    handler: (_input, { instance, source }) => {
      backend(source);
      return instance.getTheme(null);
    },
  }),
  setTheme: windowsOperation({
    input: themeChange,
    output: themeStateSchema,
    handler: ({ theme }, { instance, source }) => {
      backend(source);
      return instance.setTheme(null, theme);
    },
  }),
};

const macosOperation =
  defineNativeOperation<
    ReturnType<typeof import("#appearance/platforms/macos").initialize>
  >();
export const macosAppearanceOperations = {
  ...appearanceOperations,
  getTheme: macosOperation({
    input: z.null(),
    output: themeStateSchema,
    handler: (_input, { instance, source }) => {
      backend(source);
      return instance.getTheme();
    },
  }),
  setTheme: macosOperation({
    input: themeChange,
    output: themeStateSchema,
    handler: ({ theme }, { instance, source }) => {
      backend(source);
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
