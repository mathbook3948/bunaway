import {
  MAX_WINDOW_COORDINATE,
  MIN_WINDOW_COORDINATE,
} from "@bunaway/plugin-api/native";
import {
  errorSchema,
  type JsonValue,
  validateValue,
  type WireError,
} from "@bunaway/protocol";
import { z } from "zod";

const coordinate = z
  .int()
  .min(MIN_WINDOW_COORDINATE)
  .max(MAX_WINDOW_COORDINATE);
export const monitorPointSchema = z.strictObject({
  x: coordinate,
  y: coordinate,
});
export const monitorRectSchema = z
  .strictObject({
    ...monitorPointSchema.shape,
    width: z.int().positive().max(MAX_WINDOW_COORDINATE),
    height: z.int().positive().max(MAX_WINDOW_COORDINATE),
  })
  .refine(
    (rect) =>
      rect.x + rect.width <= MAX_WINDOW_COORDINATE &&
      rect.y + rect.height <= MAX_WINDOW_COORDINATE,
  );
/** Physical virtual-screen bounds and work area, effective DPI and optional driver metrics. */
export const monitorSchema = z.strictObject({
  id: z.string().min(1).max(32),
  name: z.string().min(1).max(128),
  primary: z.boolean(),
  bounds: monitorRectSchema,
  workArea: monitorRectSchema,
  dpi: z.int().positive().max(65535),
  scaleFactor: z
    .number()
    .positive()
    .max(65535 / 96),
  rotation: z.union([
    z.literal(0),
    z.literal(90),
    z.literal(180),
    z.literal(270),
    z.null(),
  ]),
  refreshRate: z.union([
    z.int().min(2),
    z.null(),
  ]),
});
export type Monitor = z.output<typeof monitorSchema>;

// TypeScript declaration emission narrows the inferred empty details schema to {}.
// Spell out its JSON value type so the public contract retains null and primitives.
const monitorErrorSchema: z.ZodType<
  Omit<WireError, "details"> & {
    details?: JsonValue;
  }
> = z.unknown().transform((value) => validateValue(errorSchema, value));

/** Fresh observation used to recover after subscribing, navigation or a failed native query. */
export const monitorSnapshotSchema = z.strictObject({
  sourceId: z.uuid(),
  revision: z.int().nonnegative(),
  monitors: z.array(monitorSchema),
  error: z.union([
    z.null(),
    monitorErrorSchema,
  ]),
});
export type MonitorSnapshot = z.output<typeof monitorSnapshotSchema>;

/** Native event transport uses the protocol JSON-schema subset; metrics stay in the Zod snapshot. */
export const monitorChangeSchema = {
  type: "object",
  properties: {
    sourceId: {
      type: "string",
      maxLength: 36,
      pattern:
        "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$(?![\\s\\S])",
    },
    revision: {
      type: "integer",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    added: {
      type: "array",
      uniqueItems: true,
      items: {
        type: "string",
        maxLength: 32,
        pattern: "^[\\s\\S]+$",
      },
    },
    removed: {
      type: "array",
      uniqueItems: true,
      items: {
        type: "string",
        maxLength: 32,
        pattern: "^[\\s\\S]+$",
      },
    },
    changed: {
      type: "array",
      uniqueItems: true,
      items: {
        type: "string",
        maxLength: 32,
        pattern: "^[\\s\\S]+$",
      },
    },
    error: {
      anyOf: [
        {
          const: null,
        },
        errorSchema,
      ],
    },
  },
  required: [
    "sourceId",
    "revision",
    "added",
    "removed",
    "changed",
    "error",
  ],
  additionalProperties: false,
} as const;
