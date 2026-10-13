import { z } from "zod";

const theme = z.union([
  z.literal("light"),
  z.literal("dark"),
  z.null(),
]);
const color = z.string().regex(/^#[0-9a-f]{6}$/);
/** Live Windows user preferences and OS color/accessibility indicators. */
export const appearanceOperations = {
  getPreferences: {
    input: z.null(),
    output: z.strictObject({
      appsTheme: theme,
      systemTheme: theme,
      accentColor: color,
      highContrast: z.boolean(),
      forcedColors: z.boolean(),
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
    }),
  },
} as const;
export type AppearancePreferences = z.output<
  typeof appearanceOperations.getPreferences.output
>;
