import { z } from "zod";

/** Newest crash dumps kept in the dump folder; older ones are deleted when the plugin enables or lists. */
export const MAX_CRASH_DUMPS = 10;
/** Total size of the kept dumps; the oldest are deleted until the folder fits. */
export const MAX_CRASH_DUMP_TOTAL_BYTES = 256 * 1024 * 1024;
/** Directory entries one scan looks at; entries past this are ignored, never read. */
export const MAX_SCANNED_ENTRIES = 1000;
/** Folder below the app data directory that receives the dumps; the caller cannot choose another one. */
export const DUMP_FOLDER_NAME = "crash-dumps";

export const crashDumpKindSchema = z.enum([
  "mini",
  "full",
  "unknown",
]);
/** What a dump holds: a minidump, a dump with all process memory, or a file whose header is not recognized. */
export type CrashDumpKind = z.infer<typeof crashDumpKindSchema>;

const idSchema = z.string().regex(/^[0-9a-f]{32}$/);
export const crashDumpSchema = z.strictObject({
  id: idSchema,
  createdAtMs: z.number().int().min(0),
  sizeBytes: z.number().int().min(0),
  kind: crashDumpKindSchema,
});
/** One dump the host kept. `id` is made by the host; neither the file name nor its path is reported. */
export type CrashDump = z.infer<typeof crashDumpSchema>;
export const crashDumpListSchema = z
  .array(crashDumpSchema)
  .max(MAX_CRASH_DUMPS);

export const removeInputSchema = z.strictObject({
  id: idSchema,
});
/** Input of crashReport.remove. */
export type CrashReportRemoveInput = z.infer<typeof removeInputSchema>;
export const removeOutputSchema = z.strictObject({
  removed: z.boolean(),
});
/** `removed` is false when no dump has the id, for example because it was already pruned. */
export type CrashReportRemoveResult = z.infer<typeof removeOutputSchema>;

/** What every platform adapter provides; operations are typed by this interface, not by a platform module. */
export interface CrashReportInstance {
  enable(): null;
  disable(): null;
  list(): CrashDump[];
  remove(input: CrashReportRemoveInput): CrashReportRemoveResult;
}
