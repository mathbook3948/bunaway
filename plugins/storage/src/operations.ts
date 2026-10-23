import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import {
  type StorageInstance,
  storageBytesReadSchema,
  storageBytesSchema,
  storageBytesWriteSchema,
  storageDirectoryCreateSchema,
  storageDirectoryEntriesSchema,
  storageDirectoryPageReadSchema,
  storageDirectoryPageSchema,
  storageDirectorySizeSchema,
  storageLocationSchema,
  storageMetadataSchema,
  storageRecursivePageSchema,
  storageRecursiveReadSchema,
  storageTransferSchema,
  storageWriteSchema,
} from "#storage/contract";

/** Complete operations of every storage implementation; imports allocate no native resources. */
const operation = defineNativeOperation<StorageInstance>();
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
    input: storageBytesReadSchema,
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
  // A separate operation, so granting readDirectory never grants paged reads of large directories.
  readDirectoryPage: operation({
    input: storageDirectoryPageReadSchema,
    output: storageDirectoryPageSchema,
    handler: (input, { instance }) => instance.readDirectoryPage(input),
  }),
  // A separate operation, so granting readDirectory never grants listing whole trees.
  readDirectoryRecursive: operation({
    input: storageRecursiveReadSchema,
    output: storageRecursivePageSchema,
    handler: (input, { instance, signal }) =>
      instance.readDirectoryRecursive(input, signal),
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
  move: operation({
    input: storageTransferSchema,
    output: z.null(),
    handler: (input, { instance }) => instance.move(input),
  }),
  directorySize: operation({
    input: storageLocationSchema,
    output: storageDirectorySizeSchema,
    handler: (input, { instance, signal }) =>
      instance.directorySize(input, signal),
  }),
  remove: operation({
    input: storageLocationSchema,
    output: z.null(),
    handler: (input, { instance }) => instance.remove(input),
  }),
  // A separate operation, so granting file removal never grants deleting whole trees.
  removeRecursive: operation({
    input: storageLocationSchema,
    output: z.null(),
    handler: (input, { instance, signal }) =>
      instance.removeRecursive(input, signal),
  }),
};
