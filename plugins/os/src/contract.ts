import { z } from "zod";

const text = z.string().max(1024);
/** Read-only Windows and bundled-runtime metadata; no paths or environment variables are exposed. */
export const osOperations = {
  info: {
    input: z.null(),
    output: z.strictObject({
      platform: z.literal("windows"),
      type: text,
      release: text,
      version: text,
      architecture: text,
      hostname: text,
      runtime: z.strictObject({
        name: z.literal("bun"),
        version: text,
        pid: z.number().int().positive(),
      }),
    }),
  },
  locale: {
    input: z.null(),
    output: z.strictObject({
      locale: z.string().max(85),
      countryCode: z.string().max(3).nullable(),
      preferredLanguages: z.array(z.string().min(1).max(85)).max(128),
      systemLanguage: z.string().max(85),
    }),
  },
} as const;
/** OS and runtime snapshot returned by os.info. */
export type OSInfo = z.infer<typeof osOperations.info.output>;
/** Windows user locale, ordered display languages and system UI language. */
export type OSLocale = z.infer<typeof osOperations.locale.output>;
