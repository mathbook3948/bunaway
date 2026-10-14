import { z } from "zod";

export const MAX_LOG_ARCHIVES = 10;

const logLevelSchema = z.enum([
  "debug",
  "info",
  "warn",
  "error",
]);

/** App-owned settings. Omitted fields retain this instance's current values. */
export const logConfigurationSchema = z.strictObject({
  minimumLevel: logLevelSchema.exactOptional(),
  target: z.literal("appData").exactOptional(),
  maxFileBytes: z
    .number()
    .int()
    .min(1024)
    .max(64 * 1024 * 1024)
    .exactOptional(),
  maxArchives: z.number().int().min(0).max(MAX_LOG_ARCHIVES).exactOptional(),
});

/** Backend-only settings accepted by `log.configure`. */
export type LogConfiguration = z.infer<typeof logConfigurationSchema>;
/** Structured log input and completion contract. */
export const logInputSchema = z.strictObject({
  level: logLevelSchema,
  message: z
    .string()
    .refine(
      (value) => Array.from(value).length <= 1024,
      "Text exceeds the Unicode character limit.",
    ),
  details: z.json().exactOptional(),
});
/** Input accepted by `log.write` and the level-specific helpers. */
export type LogInput = z.infer<typeof logInputSchema>;
