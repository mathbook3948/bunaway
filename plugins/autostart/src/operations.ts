import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import { enableSchema, statusSchema } from "./contract.ts";
import {
  disable,
  enable,
  getStatus,
  type initialize,
} from "./platforms/windows.ts";

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
