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
