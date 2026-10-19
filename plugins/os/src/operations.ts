import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import {
  beepInputSchema,
  infoSchema,
  localeSchema,
  type OSInstance,
  usageSchema,
} from "#os/contract";

const operation = defineNativeOperation<OSInstance>();
/** Read-only OS metadata; no paths or environment variables are exposed. */
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
  beep: operation({
    input: beepInputSchema,
    output: z.null(),
    handler: (input, { instance }) => instance.beep(input.kind),
  }),
};
