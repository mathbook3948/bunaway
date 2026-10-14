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

/** Both platforms read the same preference snapshot without platform-specific handler decisions. */
export type AppearanceInstance = {
  read(): AppearancePreferences;
};
