import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import {
  storageBytesSchema,
  storageBytesWriteSchema,
  storageDirectoryCreateSchema,
  storageDirectoryEntriesSchema,
  storageLocationSchema,
  storageMetadataSchema,
  storageTransferSchema,
  storageWriteSchema,
} from "#storage/contract";
import type { MacosStorage } from "#storage/platforms/macos";
import type { WindowsStorage } from "#storage/platforms/windows";

/** Complete operations shared by both storage implementations; imports allocate no native resources. */
const operation = defineNativeOperation<MacosStorage | WindowsStorage>();
export const storageOperations = {
  readText: operation({
    input: storageLocationSchema,
    output: z.string(),
    handler: (input, { instance }) => instance.readText(input),
  }),
  writeText: operation({
    input: storageWriteSchema,
    output: z.null(),
    handler: (input, { instance }) => instance.writeText(input),
  }),
  readBytes: operation({
    input: storageLocationSchema,
    output: storageBytesSchema,
    handler: (input, { instance }) => instance.readBytes(input),
  }),
  writeBytes: operation({
    input: storageBytesWriteSchema,
    output: z.null(),
    handler: (input, { instance }) => instance.writeBytes(input),
  }),
  appendBytes: operation({
    input: storageBytesWriteSchema,
    output: z.null(),
    handler: (input, { instance }) => instance.appendBytes(input),
  }),
  appendText: operation({
    input: storageWriteSchema,
    output: z.null(),
    handler: (input, { instance }) => instance.appendText(input),
  }),
  copyFile: operation({
    input: storageTransferSchema,
    output: z.null(),
    handler: (input, { instance }) => instance.copyFile(input),
  }),
  readDirectory: operation({
    input: storageLocationSchema,
    output: storageDirectoryEntriesSchema,
    handler: (input, { instance }) => instance.readDirectory(input),
  }),
  createDirectory: operation({
    input: storageDirectoryCreateSchema,
    output: z.null(),
    handler: (input, { instance }) => instance.createDirectory(input),
  }),
  exists: operation({
    input: storageLocationSchema,
    output: z.boolean(),
    handler: (input, { instance }) => instance.exists(input),
  }),
  stat: operation({
    input: storageLocationSchema,
    output: z.union([
      storageMetadataSchema,
      z.null(),
    ]),
    handler: (input, { instance }) => instance.stat(input),
  }),
};
