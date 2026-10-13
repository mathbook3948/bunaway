import { z } from "zod";

const MAX_PATH_CODE_UNITS = 4096;
const PATH_PATTERN = "^[^\\u0000\\r\\n]*$(?![\\s\\S])";
/** Strings are lexical paths; only resolve's base must be fully qualified. */
// Zod max counts code points; JavaScript length enforces the documented UTF-16 bound.
const pathText = z
  .string()
  .max(MAX_PATH_CODE_UNITS)
  .refine(
    (value) => value.length <= MAX_PATH_CODE_UNITS,
    "Path exceeds the UTF-16 code unit limit.",
  )
  .regex(new RegExp(PATH_PATTERN, "u"));
const paths = z.array(pathText).max(64);
const qualifiedPath = pathText
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

/** Windows lexical helpers and OS-selected user directories, with independent operation grants. */
export const pathOperations = {
  getDirectory: {
    input: z.strictObject({
      directory: userDirectorySchema,
    }),
    output: qualifiedPath,
  },
  join: {
    input: z.strictObject({
      paths,
    }),
    output: pathText,
  },
  resolve: {
    input: z.strictObject({
      base: qualifiedPath,
      // Per-drive relative paths would consult the host's implicit drive working directory.
      paths: paths.refine((values) =>
        values.every((value) => !/^[A-Za-z]:(?![\\/])/.test(value)),
      ),
    }),
    output: qualifiedPath,
  },
  normalize: {
    input: z.strictObject({
      path: pathText,
    }),
    output: pathText,
  },
  basename: {
    input: z.strictObject({
      path: pathText,
      suffix: pathText.optional(),
    }),
    output: pathText,
  },
  dirname: {
    input: z.strictObject({
      path: pathText,
    }),
    output: pathText,
  },
  extname: {
    input: z.strictObject({
      path: pathText,
    }),
    output: pathText,
  },
  isAbsolute: {
    input: z.strictObject({
      path: pathText,
    }),
    output: z.boolean(),
  },
} as const;

/** Parsed operation inputs carried inside the native adapter after SDK validation. */
export type PathInput = z.infer<
  (typeof pathOperations)[keyof typeof pathOperations]["input"]
>;
/** A supported current-user directory name. */
export type UserDirectory = z.infer<typeof userDirectorySchema>;
