import { z } from "zod";

const MAX_PATH_CODE_UNITS = 4096;
const PATH_PATTERN = "^[^\\u0000\\r\\n]*$(?![\\s\\S])";
/** Strings are lexical paths; only resolve's base must be fully qualified. */
// Zod max counts code points; JavaScript length enforces the documented UTF-16 bound.
export const pathTextSchema = z
  .string()
  .max(MAX_PATH_CODE_UNITS)
  .refine(
    (value) => value.length <= MAX_PATH_CODE_UNITS,
    "Path exceeds the UTF-16 code unit limit.",
  )
  .regex(new RegExp(PATH_PATTERN, "u"));
export const pathsSchema = z.array(pathTextSchema).max(64);
export const qualifiedPathSchema = pathTextSchema
  .min(1)
  .regex(/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/);

/** Current-user Windows known folders. Querying one neither creates it nor grants file access. */
export const userDirectorySchema = z.enum([
  "home",
  "documents",
  "downloads",
  "desktop",
  "pictures",
  "music",
  "videos",
]);

/** A supported current-user directory name. */
export type UserDirectory = z.infer<typeof userDirectorySchema>;

/**
 * App-specific directories. Querying one neither creates it nor grants file access.
 * App resources are not included: `ctx.app.paths.resources` provides them.
 */
export const appDirectorySchema = z.enum([
  "appConfig",
  "appData",
  "appLocalData",
  "cache",
  "logs",
  "temp",
]);

/** A supported app-specific directory name. */
export type AppDirectory = z.infer<typeof appDirectorySchema>;
