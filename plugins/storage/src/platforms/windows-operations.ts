import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import {
  storageDirectorySizeSchema,
  storageLocationSchema,
  storageTransferSchema,
  type WindowsStorageInstance,
} from "#storage/contract";
import { storageOperations } from "#storage/operations";

const operation = defineNativeOperation<WindowsStorageInstance>();
/** Windows adds handle-preserving move, removal and recursive size to the shared storage operations. */
export const windowsOperations = {
  ...storageOperations,
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
};
