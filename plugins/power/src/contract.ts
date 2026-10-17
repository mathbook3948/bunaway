import { z } from "zod";
export const MAX_POWER_BLOCKERS = 128;

const nullableBoolean = z.union([
  z.boolean(),
  z.null(),
]);
const nullableSeconds = z.union([
  z.int().nonnegative().max(0xfffffffe),
  z.null(),
]);
export const blockerTypeSchema = z.enum([
  "system",
  "display",
]);
export const blockerSchema = z.strictObject({
  id: z.uuid(),
  type: blockerTypeSchema,
});
export const blockerIdSchema = z.strictObject({
  id: blockerSchema.shape.id,
});
/** Status queries and independently granted, app-owned power request handles. */
export const statusSchema = z.strictObject({
  source: z.enum([
    "ac",
    "battery",
    "unknown",
  ]),
  batteryPresent: nullableBoolean,
  charging: nullableBoolean,
  batteryPercent: z.union([
    z.int().min(0).max(100),
    z.null(),
  ]),
  batterySaver: z.boolean(),
  remainingSeconds: nullableSeconds,
  fullLifeSeconds: nullableSeconds,
});
export const idleTimeSchema = z
  .int()
  .nonnegative()
  .max(Math.floor(0xffffffff / 1000));
export const idleThresholdSchema = z.strictObject({
  thresholdSeconds: z
    .int()
    .min(1)
    .max(Math.floor(0xffffffff / 1000)),
});
export const blockerInputSchema = z.strictObject({
  type: blockerTypeSchema,
  reason: z
    .string()
    .min(1)
    .max(512)
    .refine((value) => !value.includes("\0"), "Reason must not contain NUL."),
});
export type PowerStatus = z.output<typeof statusSchema>;
export type PowerBlocker = z.output<typeof blockerSchema>;
export type PowerBlockerType = PowerBlocker["type"];

const eventNullableBoolean = {
  anyOf: [
    {
      type: "boolean",
    },
    {
      const: null,
    },
  ],
} as const;
const eventSeconds = {
  anyOf: [
    {
      type: "integer",
      minimum: 0,
      maximum: 0xfffffffe,
    },
    {
      const: null,
    },
  ],
} as const;
const emptyEvent = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;
/**
 * Native events use the protocol's portable schema representation. The `power.statusChanged` payload
 * equals `statusSchema`. The lifecycle events carry an empty object and correspond to Electron
 * powerMonitor `suspend`, `resume`, `lock-screen` and `unlock-screen`. Lock events report WTS
 * session lock of the calling process's session.
 */
export const powerEvents = {
  "power.statusChanged": {
    type: "object",
    properties: {
      source: {
        enum: [
          "ac",
          "battery",
          "unknown",
        ],
      },
      batteryPresent: eventNullableBoolean,
      charging: eventNullableBoolean,
      batteryPercent: {
        anyOf: [
          {
            type: "integer",
            minimum: 0,
            maximum: 100,
          },
          {
            const: null,
          },
        ],
      },
      batterySaver: {
        type: "boolean",
      },
      remainingSeconds: eventSeconds,
      fullLifeSeconds: eventSeconds,
    },
    required: [
      "source",
      "batteryPresent",
      "charging",
      "batteryPercent",
      "batterySaver",
      "remainingSeconds",
      "fullLifeSeconds",
    ],
    additionalProperties: false,
  },
  "power.suspended": emptyEvent,
  "power.resumed": emptyEvent,
  "power.sessionLocked": emptyEvent,
  "power.sessionUnlocked": emptyEvent,
} as const;
