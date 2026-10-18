import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import {
  storageLocationSchema,
  storageTransferSchema,
  type WindowsStorageInstance,
} from "#storage/contract";
import { storageOperations } from "#storage/operations";

const operation = defineNativeOperation<WindowsStorageInstance>();
/** Windows adds handle-preserving move and removal to the shared storage operations. */
export const windowsOperations = {
  ...storageOperations,
  move: operation({
    input: storageTransferSchema,
    output: z.null(),
    handler: (input, { instance }) => instance.move(input),
  }),
  remove: operation({
    input: storageLocationSchema,
    output: z.null(),
    handler: (input, { instance }) => instance.remove(input),
  }),
};
