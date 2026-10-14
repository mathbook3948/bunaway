import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import { infoSchema, localeSchema, usageSchema } from "#os/contract";
import type { initialize } from "#os/platforms/windows";

const operation = defineNativeOperation<ReturnType<typeof initialize>>();
/** Read-only Windows metadata; no paths or environment variables are exposed. */
export const osOperations = {
  info: operation({
    input: z.null(),
    output: infoSchema,
    handler: (_input, { instance }) => instance.info(),
  }),
  usage: operation({
    input: z.null(),
    output: usageSchema,
    handler: (_input, { instance }) => instance.usage(),
  }),
  locale: operation({
    input: z.null(),
    output: localeSchema,
    handler: (_input, { instance }) => instance.locale(),
  }),
};
