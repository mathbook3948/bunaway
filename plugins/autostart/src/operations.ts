import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import { enableSchema, statusSchema } from "#autostart/contract";
import {
  disable,
  enable,
  getStatus,
  type initialize,
} from "#autostart/platforms/windows";

const operation = defineNativeOperation<ReturnType<typeof initialize>>();
/** Complete Windows login registration operations. Imports never register the app. */
export const autostartOperations = {
  enable: operation({
    input: enableSchema,
    output: statusSchema,
    handler: (input, { instance }) => enable(instance, input),
  }),
  disable: operation({
    input: z.null(),
    output: z.null(),
    handler: (_input, { instance }) => disable(instance),
  }),
  getStatus: operation({
    input: z.null(),
    output: statusSchema,
    handler: (_input, { instance }) => getStatus(instance),
  }),
};
