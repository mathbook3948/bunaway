import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import { statusSchema } from "./contract.ts";
import type { initialize } from "./platforms/windows.ts";

const operation = defineNativeOperation<ReturnType<typeof initialize>>();
/** Separate notification availability/status from the fixed Windows Settings navigation request. */
export const notificationOperations = {
  getStatus: operation({
    input: z.null(),
    output: statusSchema,
    handler: (_input, { instance }) => instance.getStatus(),
  }),
  openSettings: operation({
    input: z.null(),
    output: z.null(),
    handler: (_input, { instance }) => instance.openSettings(),
  }),
};
