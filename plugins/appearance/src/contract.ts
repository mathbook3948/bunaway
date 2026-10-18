import { z } from "zod";

const theme = z.union([
  z.literal("light"),
  z.literal("dark"),
  z.null(),
]);
const color = z.string().regex(/^#[0-9a-f]{6}$/);
/** Live OS appearance and accessibility indicators. Platform mappings are documented in the appearance reference. */
export const preferencesSchema = z.strictObject({
  appsTheme: theme,
  systemTheme: theme,
  accentColor: color,
  highContrast: z.boolean(),
  forcedColors: z.boolean(),
  invertedColors: z.boolean(),
  reducedMotion: z.boolean(),
  transparencyEnabled: z.union([
    z.boolean(),
    z.null(),
  ]),
  screenReaderEnabled: z.boolean(),
  colors: z.strictObject({
    window: color,
    windowText: color,
    highlight: color,
    highlightText: color,
  }),
});
export type AppearancePreferences = z.output<typeof preferencesSchema>;

/**
 * Windows only. `screenReaderEnabled` is the SPI_GETSCREENREADER setting flag.
 * `assistiveTechnologyActive` is true while a UI Automation client (screen reader,
 * magnifier and similar) is listening, as reported by `UiaClientsAreListening`.
 */
export const accessibilityStateSchema = z.strictObject({
  screenReaderEnabled: z.boolean(),
  assistiveTechnologyActive: z.boolean(),
});
export type AccessibilityState = z.output<typeof accessibilityStateSchema>;

export const themePreferenceSchema = z.enum([
  "system",
  "light",
  "dark",
]);
export type ThemePreference = z.output<typeof themePreferenceSchema>;
/** A window override is null when it inherits the app preference. High contrast suspends frame dark mode. */
export const themeStateSchema = z.strictObject({
  preference: themePreferenceSchema,
  override: themePreferenceSchema.nullable(),
  effectiveTheme: theme,
  highContrast: z.boolean(),
});
export type ThemeState = z.output<typeof themeStateSchema>;

/** Both platforms read the same preference snapshot without platform-specific handler decisions. */
export type AppearanceInstance = {
  read(): AppearancePreferences;
};

const eventTheme = {
  anyOf: [
    {
      enum: [
        "light",
        "dark",
      ],
    },
    {
      const: null,
    },
  ],
} as const;
const eventColor = {
  type: "string",
  pattern: "^#[0-9a-f]{6}$",
} as const;
/** Native events use the protocol's portable schema representation. */
export const appearanceEvents = {
  "appearance.changed": {
    type: "object",
    properties: {
      appsTheme: eventTheme,
      systemTheme: eventTheme,
      accentColor: eventColor,
      highContrast: {
        type: "boolean",
      },
      forcedColors: {
        type: "boolean",
      },
      invertedColors: {
        type: "boolean",
      },
      reducedMotion: {
        type: "boolean",
      },
      transparencyEnabled: {
        anyOf: [
          {
            type: "boolean",
          },
          {
            const: null,
          },
        ],
      },
      screenReaderEnabled: {
        type: "boolean",
      },
      colors: {
        type: "object",
        properties: {
          window: eventColor,
          windowText: eventColor,
          highlight: eventColor,
          highlightText: eventColor,
        },
        required: [
          "window",
          "windowText",
          "highlight",
          "highlightText",
        ],
        additionalProperties: false,
      },
    },
    required: [
      "appsTheme",
      "systemTheme",
      "accentColor",
      "highContrast",
      "forcedColors",
      "invertedColors",
      "reducedMotion",
      "transparencyEnabled",
      "screenReaderEnabled",
      "colors",
    ],
    additionalProperties: false,
  },
} as const;
