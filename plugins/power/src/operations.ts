import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import {
  blockerIdSchema,
  blockerInputSchema,
  blockerSchema,
  cpuSpeedLimitSchema,
  idleThresholdSchema,
  idleTimeSchema,
  MAX_POWER_BLOCKERS,
  type PowerQueries,
  statusSchema,
} from "#power/contract";
import type { WindowsPower } from "#power/platforms/windows";

const operation = defineNativeOperation<WindowsPower>();
const macosOperation = defineNativeOperation<PowerQueries>();
/** macOS answers the read-only queries only; the other operations are unsupported there. */
export const macosPowerOperations = {
  getStatus: macosOperation({
    input: z.null(),
    output: statusSchema,
    handler: (_input, { instance }) => instance.getStatus(),
  }),
  getIdleTime: macosOperation({
    input: z.null(),
    output: idleTimeSchema,
    handler: (_input, { instance }) => instance.getIdleTime(),
  }),
  getIdleState: macosOperation({
    input: idleThresholdSchema,
    output: z.enum([
      "active",
      "idle",
    ]),
    handler: ({ thresholdSeconds }, { instance }) =>
      instance.getIdleState(thresholdSeconds),
  }),
};
/** Windows power queries and independently owned sleep/display request handles. */
export const powerOperations = {
  getStatus: operation({
    input: z.null(),
    output: statusSchema,
    handler: (_input, { instance }) => instance.getStatus(),
  }),
  getCpuSpeedLimit: operation({
    input: z.null(),
    output: cpuSpeedLimitSchema,
    handler: (_input, { instance }) => instance.getCpuSpeedLimit(),
  }),
  getIdleTime: operation({
    input: z.null(),
    output: idleTimeSchema,
    handler: (_input, { instance }) => instance.getIdleTime(),
  }),
  getIdleState: operation({
    input: idleThresholdSchema,
    output: z.enum([
      "active",
      "idle",
    ]),
    handler: ({ thresholdSeconds }, { instance }) =>
      instance.getIdleState(thresholdSeconds),
  }),
  startBlocker: operation({
    input: blockerInputSchema,
    output: blockerSchema,
    handler: (input, { instance }) => instance.startBlocker(input),
  }),
  listBlockers: operation({
    input: z.null(),
    output: z.array(blockerSchema).max(MAX_POWER_BLOCKERS),
    handler: (_input, { instance }) => instance.listBlockers(),
  }),
  isBlockerActive: operation({
    input: blockerIdSchema,
    output: z.boolean(),
    handler: ({ id }, { instance }) => instance.isBlockerActive(id),
  }),
  stopBlocker: operation({
    input: blockerIdSchema,
    output: z.boolean(),
    handler: ({ id }, { instance }) => instance.stopBlocker(id),
  }),
};
