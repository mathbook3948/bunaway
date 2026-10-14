import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import { logInputSchema } from "./contract.ts";
import { write as writeMacos } from "./platforms/macos.ts";
import { write as writeWindows } from "./platforms/windows.ts";

const operation = defineNativeOperation<string>();
/** Each platform declares its own native log writer and receives the trusted caller source. */
export const macosOperations = {
  write: operation({
    input: logInputSchema,
    output: z.null(),
    handler: (input, { instance, source }) =>
      writeMacos(instance, input, source),
  }),
};
export const windowsOperations = {
  write: operation({
    input: logInputSchema,
    output: z.null(),
    handler: (input, { instance, source }) =>
      writeWindows(instance, input, source),
  }),
};
