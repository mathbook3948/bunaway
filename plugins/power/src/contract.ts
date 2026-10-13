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
const blockerType = z.enum([
  "system",
  "display",
]);
const blocker = z.strictObject({
  id: z.uuid(),
  type: blockerType,
});
const blockerId = z.strictObject({
  id: blocker.shape.id,
});
/** Status queries and independently granted, app-owned power request handles. */
export const powerOperations = {
  getStatus: {
    input: z.null(),
    output: z.strictObject({
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
    }),
  },
  getIdleTime: {
    input: z.null(),
    output: z
      .int()
      .nonnegative()
      .max(Math.floor(0xffffffff / 1000)),
  },
  getIdleState: {
    input: z.strictObject({
      thresholdSeconds: z
        .int()
        .min(1)
        .max(Math.floor(0xffffffff / 1000)),
    }),
    output: z.enum([
      "active",
      "idle",
    ]),
  },
  startBlocker: {
    input: z.strictObject({
      type: blockerType,
      reason: z
        .string()
        .min(1)
        .max(512)
        .refine(
          (value) => !value.includes("\0"),
          "Reason must not contain NUL.",
        ),
    }),
    output: blocker,
  },
  listBlockers: {
    input: z.null(),
    output: z.array(blocker).max(MAX_POWER_BLOCKERS),
  },
  isBlockerActive: {
    input: blockerId,
    output: z.boolean(),
  },
  stopBlocker: {
    input: blockerId,
    output: z.boolean(),
  },
} as const;
export type PowerStatus = z.output<typeof powerOperations.getStatus.output>;
export type PowerBlocker = z.output<typeof blocker>;
export type PowerBlockerType = PowerBlocker["type"];
