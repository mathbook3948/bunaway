import { BunawayError, defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import type { AppLog } from "#log/app-log";
import { logConfigurationSchema, logInputSchema } from "#log/contract";

const operation = defineNativeOperation<AppLog>();
/** Shared file contract; the host supplies the instance and trusted caller source. */
export const windowsOperations = {
  write: operation({
    input: logInputSchema,
    output: z.null(),
    handler: (input, { instance, source }) => instance.write(input, source),
  }),
  configure: operation({
    input: logConfigurationSchema,
    output: z.null(),
    handler(input, { instance, source }) {
      if (source !== "backend") {
        throw new BunawayError({
          code: "PERMISSION_DENIED",
          message: "Only the backend can configure app logging.",
        });
      }
      return instance.configure(input);
    },
  }),
  flush: operation({
    input: z.null(),
    output: z.null(),
    handler: (_input, { instance }) => instance.flush(),
  }),
};

export const macosOperations = {
  write: windowsOperations.write,
  configure: windowsOperations.configure,
  flush: windowsOperations.flush,
};
