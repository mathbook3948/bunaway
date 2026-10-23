import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import {
  checkOutputSchema,
  downloadOutputSchema,
  downloadStatusOutputSchema,
  type UpdaterInstance,
} from "#updater/contract";

const operation = defineNativeOperation<UpdaterInstance>();
/** Each operation requires its own permission, named after the operation. */
export const updaterOperations = {
  check: operation({
    input: z.null(),
    output: checkOutputSchema,
    handler: (_input, { instance, signal }) => instance.check(signal),
  }),
  download: operation({
    input: z.null(),
    output: downloadOutputSchema,
    handler: (_input, { instance, signal }) => instance.download(signal),
  }),
  downloadStatus: operation({
    input: z.null(),
    output: downloadStatusOutputSchema,
    handler: (_input, { instance }) => instance.downloadStatus(),
  }),
};
