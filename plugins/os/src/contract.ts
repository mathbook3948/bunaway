import { z } from "zod";

const text = z.string().max(1024);
/** Read-only Windows and bundled-runtime metadata; no paths or environment variables are exposed. */
export const infoSchema = z.strictObject({
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
});
export const usageSchema = z.strictObject({
  pid: z.number().int().positive(),
  logicalCpuCount: z.number().int().nonnegative(),
  cpuTime: z.strictObject({
    userMicros: z.number().int().nonnegative(),
    systemMicros: z.number().int().nonnegative(),
  }),
  memory: z.strictObject({
    systemTotalBytes: z.number().int().nonnegative(),
    systemFreeBytes: z.number().int().nonnegative(),
    processResidentBytes: z.number().int().nonnegative(),
  }),
  translation: z.strictObject({
    active: z.boolean(),
    processMachine: z.number().int().min(0).max(65535),
    nativeMachine: z.number().int().min(0).max(65535),
  }),
});
export const localeSchema = z.strictObject({
  locale: z.string().max(85),
  countryCode: z.string().max(3).nullable(),
  preferredLanguages: z.array(z.string().min(1).max(85)).max(128),
  systemLanguage: z.string().max(85),
});
/** Windows system sound played by os.beep; defaults to the plain default beep. */
export const beepInputSchema = z.strictObject({
  kind: z
    .enum([
      "default",
      "info",
      "warning",
      "error",
    ])
    .default("default"),
});
/** Caller input for os.beep; `kind` may be omitted and then defaults to "default". */
export type OSBeepInput = z.input<typeof beepInputSchema>;
/** OS and runtime snapshot returned by os.info. */
export type OSInfo = z.infer<typeof infoSchema>;
/** Windows user locale, ordered display languages and system UI language. */
export type OSLocale = z.infer<typeof localeSchema>;

/** Process CPU time, memory and Windows architecture translation snapshot. */
export type OSUsage = z.infer<typeof usageSchema>;
/**
 * What the os operations call on the per-plugin instance. Operations are typed by this
 * interface, never by a platform module, so a new platform implements the contract instead of
 * matching another platform's shape by accident.
 */
export interface OSInstance {
  info(): OSInfo;
  usage(): OSUsage;
  locale(): OSLocale;
  beep(kind: NonNullable<OSBeepInput["kind"]>): null;
  dispose(): void;
}
