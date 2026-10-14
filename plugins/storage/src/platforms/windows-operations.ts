import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import { storageLocationSchema, storageTransferSchema } from "../contract.ts";
import { storageOperations } from "../operations.ts";
import type { WindowsStorage } from "./windows.ts";

const operation = defineNativeOperation<WindowsStorage>();
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
