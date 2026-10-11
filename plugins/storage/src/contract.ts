import { z } from "zod";

const PATH_PATTERN = "^[^\\u0000\\r\\n]+$(?![\\s\\S])";
const pathFields = {
  // The application selects the path; native implementations validate OS path syntax.
  path: z.string().max(4096).regex(new RegExp(PATH_PATTERN, "u")),
};
const storageTimes = {
  createdAtMs: z.union([
    z.int(),
    z.null(),
  ]),
  modifiedAtMs: z.union([
    z.int(),
    z.null(),
  ]),
  accessedAtMs: z.union([
    z.int(),
    z.null(),
  ]),
} as const;
const storageMetadata = z.union([
  z.strictObject({
    kind: z.enum([
      "file",
    ]),
    sizeBytes: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
    ...storageTimes,
  }),
  z.strictObject({
    kind: z.enum([
      "directory",
    ]),
    sizeBytes: z.null(),
    ...storageTimes,
  }),
]);
/** Text and metadata contracts for paths selected by the application. */
export const storageOperations = {
  readText: {
    input: z.strictObject(pathFields),
    output: z.string(),
  },
  writeText: {
    input: z.strictObject({
      ...pathFields,
      text: z.string(),
    }),
    output: z.null(),
  },
  exists: {
    input: z.strictObject(pathFields),
    output: z.boolean(),
  },
  stat: {
    input: z.strictObject(pathFields),
    output: z.union([
      storageMetadata,
      z.null(),
    ]),
  },
} as const;
/** Path accepted by read and metadata operations. */
export type StorageLocation = z.infer<typeof storageOperations.readText.input>;
/** Path and text accepted by `storage.writeText`. */
export type StorageWrite = z.infer<typeof storageOperations.writeText.input>;
/** File or directory metadata returned by `storage.stat`. */
export type StorageMetadata = NonNullable<
  z.infer<typeof storageOperations.stat.output>
>;
