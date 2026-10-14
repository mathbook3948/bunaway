import type { NativeInvokeOptions } from "@bunaway/plugin";
import { z } from "zod";

/** A bounded listing fits the JSON transport even for maximally escaped Windows filenames. */
export const MAX_DIRECTORY_ENTRIES = 256;
export const MAX_FILENAME_CHARACTERS = 255;

/** An observed child name and kind. This does not authorize or follow the child target. */
export const directoryEntrySchema = z.strictObject({
  name: z.string().min(1).max(MAX_FILENAME_CHARACTERS),
  kind: z.enum([
    "file",
    "directory",
    "link",
  ]),
});
export type StorageDirectoryEntry = z.infer<typeof directoryEntrySchema>;

/** Binary operations leave room for base64, path and envelope in a 1 MiB message. */
export const MAX_STORAGE_BYTES = 256 * 1024;
const MAX_BASE64_CHARACTERS = 4 * Math.ceil(MAX_STORAGE_BYTES / 3);
/** Canonical padded base64, including empty bytes, with a decoded size bound. */
export const storageBytesSchema = z
  .string()
  .max(MAX_BASE64_CHARACTERS)
  .regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$(?![\s\S])/,
  )
  .refine((value) => {
    let padding = 0;
    if (value.endsWith("==")) {
      padding = 2;
    } else if (value.endsWith("=")) {
      padding = 1;
    }
    const size = (value.length / 4) * 3 - padding;
    if (size > MAX_STORAGE_BYTES) {
      return false;
    }
    if (!padding) {
      return true;
    }
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const last = alphabet.indexOf(value[value.length - padding - 1] ?? "");
    return (last & (padding === 2 ? 15 : 3)) === 0;
  }, "Bytes must use canonical base64 within the decoded size limit.");

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
export const storageMetadataSchema = z.union([
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
/** Shared value schemas, independent of platform resource ownership. */
export const storageLocationSchema = z.strictObject(pathFields);
export const storageWriteSchema = z.strictObject({
  ...pathFields,
  text: z.string(),
});
export const storageBytesWriteSchema = z.strictObject({
  ...pathFields,
  bytes: storageBytesSchema,
});
export const storageTransferSchema = z.strictObject({
  from: pathFields.path,
  to: pathFields.path,
});
export const storageDirectoryCreateSchema = z.strictObject({
  ...pathFields,
  recursive: z.boolean().default(false),
});
export const storageDirectoryEntriesSchema = z
  .array(directoryEntrySchema)
  .max(MAX_DIRECTORY_ENTRIES);
/** Path accepted by read and metadata operations. */
export type StorageLocation = z.infer<typeof storageLocationSchema>;
/** Path and text accepted by text writes and appends. */
export type StorageWrite = z.infer<typeof storageWriteSchema>;
/** File or directory metadata returned by storage.stat. */
export type StorageMetadata = z.infer<typeof storageMetadataSchema>;
/** Path and canonical base64 accepted by byte writes and appends. */
export type StorageBytesWrite = z.infer<typeof storageBytesWriteSchema>;
/** Source and destination; transfers never replace existing targets. */
export type StorageTransfer = z.infer<typeof storageTransferSchema>;
/** Directory creation input after recursive defaults are resolved. */
export type StorageDirectoryCreate = z.infer<
  typeof storageDirectoryCreateSchema
>;

/** Public storage interface chosen by the plugin author; native support may differ by platform. */
export interface Storage {
  readText(
    input: StorageLocation,
    options?: NativeInvokeOptions,
  ): Promise<string>;
  writeText(input: StorageWrite, options?: NativeInvokeOptions): Promise<null>;
  readBytes(
    input: StorageLocation,
    options?: NativeInvokeOptions,
  ): Promise<string>;
  writeBytes(
    input: StorageBytesWrite,
    options?: NativeInvokeOptions,
  ): Promise<null>;
  appendText(input: StorageWrite, options?: NativeInvokeOptions): Promise<null>;
  appendBytes(
    input: StorageBytesWrite,
    options?: NativeInvokeOptions,
  ): Promise<null>;
  copyFile(
    input: StorageTransfer,
    options?: NativeInvokeOptions,
  ): Promise<null>;
  move(input: StorageTransfer, options?: NativeInvokeOptions): Promise<null>;
  readDirectory(
    input: StorageLocation,
    options?: NativeInvokeOptions,
  ): Promise<StorageDirectoryEntry[]>;
  createDirectory(
    input: z.input<typeof storageDirectoryCreateSchema>,
    options?: NativeInvokeOptions,
  ): Promise<null>;
  remove(input: StorageLocation, options?: NativeInvokeOptions): Promise<null>;
  exists(
    input: StorageLocation,
    options?: NativeInvokeOptions,
  ): Promise<boolean>;
  stat(
    input: StorageLocation,
    options?: NativeInvokeOptions,
  ): Promise<StorageMetadata | null>;
}
