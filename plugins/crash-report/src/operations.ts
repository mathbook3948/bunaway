import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import {
  type CrashReportInstance,
  crashDumpListSchema,
  removeInputSchema,
  removeOutputSchema,
} from "#crash-report/contract";

const operation = defineNativeOperation<CrashReportInstance>();
/** Each operation requires its own permission, named after the operation. */
export const crashReportOperations = {
  enable: operation({
    input: z.null(),
    output: z.null(),
    handler: (_input, { instance }) => instance.enable(),
  }),
  disable: operation({
    input: z.null(),
    output: z.null(),
    handler: (_input, { instance }) => instance.disable(),
  }),
  list: operation({
    input: z.null(),
    output: crashDumpListSchema,
    handler: (_input, { instance }) => instance.list(),
  }),
  remove: operation({
    input: removeInputSchema,
    output: removeOutputSchema,
    handler: (input, { instance }) => instance.remove(input),
  }),
};
