import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import {
  notificationIdentitySchema,
  notificationResultSchema,
  notificationShowSchema,
  statusSchema,
} from "#notification/contract";
import type { initialize } from "#notification/platforms/windows";

const operation = defineNativeOperation<ReturnType<typeof initialize>>();
/** Separate notification availability/status from the fixed Windows Settings navigation request. */
export const notificationOperations = {
  show: operation({
    input: notificationShowSchema,
    output: notificationResultSchema,
    handler: (input, { instance }) => instance.show(input),
  }),
  clear: operation({
    input: notificationIdentitySchema,
    output: z.null(),
    handler: (input, { instance }) => instance.clear(input),
  }),
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
