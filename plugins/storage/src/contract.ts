import { z } from "zod";
import { storageBytesSchema } from "./bytes.ts";
import {
  directoryEntrySchema,
  MAX_DIRECTORY_ENTRIES,
} from "./directory-entries.ts";

const PATH_PATTERN = "^[^\\u0000\\r\\n]+$(?![\\s\\S])";
const pathFields = {
  // The application selects the path; native implementations validate OS path syntax.
  path: z
    .string()
    .refine(
      (value) => Array.from(value).length <= 4096,
      "Text exceeds the Unicode character limit.",
    )
    .regex(new RegExp(PATH_PATTERN, "u")),
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
/** Text, bytes and metadata contracts for paths selected by the application. */
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
  readBytes: {
    input: z.strictObject(pathFields),
    output: storageBytesSchema,
  },
  writeBytes: {
    input: z.strictObject({
      ...pathFields,
      bytes: storageBytesSchema,
    }),
    output: z.null(),
  },
  appendBytes: {
    input: z.strictObject({
      ...pathFields,
      bytes: storageBytesSchema,
    }),
    output: z.null(),
  },
  appendText: {
    input: z.strictObject({
      ...pathFields,
      text: z.string(),
    }),
    output: z.null(),
  },
  copyFile: {
    input: z.strictObject({
      from: pathFields.path,
      to: pathFields.path,
    }),
    output: z.null(),
  },
  move: {
    input: z.strictObject({
      from: pathFields.path,
      to: pathFields.path,
    }),
    output: z.null(),
  },
  readDirectory: {
    input: z.strictObject(pathFields),
    output: z.array(directoryEntrySchema).max(MAX_DIRECTORY_ENTRIES),
  },
  createDirectory: {
    input: z.strictObject({
      ...pathFields,
      recursive: z.boolean().default(false),
    }),
    output: z.null(),
  },
  remove: {
    input: z.strictObject(pathFields),
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

/** Path and canonical base64 accepted by byte writes and appends. */
export type StorageBytesWrite = z.infer<
  typeof storageOperations.writeBytes.input
>;
/** Source and destination selected by the application; transfers never replace existing targets. */
export type StorageTransfer = z.infer<typeof storageOperations.copyFile.input>;

/** Directory creation input after recursive defaults are resolved. */
export type StorageDirectoryCreate = z.infer<
  typeof storageOperations.createDirectory.input
>;
