import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import {
  notificationGroupSchema,
  notificationIdentitySchema,
  notificationListSchema,
  notificationResultSchema,
  notificationScheduleSchema,
  notificationShowSchema,
  scheduledNotificationListSchema,
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
  schedule: operation({
    input: notificationScheduleSchema,
    output: notificationResultSchema,
    handler: (input, { instance }) => instance.schedule(input),
  }),
  listScheduled: operation({
    input: z.null(),
    output: scheduledNotificationListSchema,
    handler: (_input, { instance }) => instance.listScheduled(),
  }),
  cancelScheduled: operation({
    input: notificationIdentitySchema,
    output: z.null(),
    handler: (input, { instance }) => instance.cancelScheduled(input),
  }),
  clear: operation({
    input: notificationIdentitySchema,
    output: z.null(),
    handler: (input, { instance }) => instance.clear(input),
  }),
  clearGroup: operation({
    input: notificationGroupSchema,
    output: z.null(),
    handler: (input, { instance }) => instance.clearGroup(input.group),
  }),
  clearAll: operation({
    input: z.null(),
    output: z.null(),
    handler: (_input, { instance }) => instance.clearAll(),
  }),
  list: operation({
    input: z.null(),
    output: notificationListSchema,
    handler: (_input, { instance }) => instance.list(),
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
