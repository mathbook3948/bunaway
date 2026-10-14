import {
  MAX_TRAY_ICO_BYTES,
  MAX_TRAY_TOOLTIP_UNITS,
} from "@bunaway/plugin-api/native";
import { z } from "zod";

const coordinate = z.number().int().min(-2147483648).max(2147483647);
export const positionSchema = z.strictObject({
  x: coordinate,
  y: coordinate,
});
export const tooltipSchema = z
  .string()
  .max(MAX_TRAY_TOOLTIP_UNITS)
  .refine(
    (value) => value.length <= MAX_TRAY_TOOLTIP_UNITS,
    "Tray tooltip exceeds the UTF-16 limit.",
  )
  .regex(/^[^\0\uD800-\uDFFF]*$(?![\s\S])/u);
export const icoSchema = z
  .string()
  .min(4)
  .max(Math.ceil(MAX_TRAY_ICO_BYTES / 3) * 4)
  .regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$(?![\s\S])/,
  );
export const snapshotSchema = z.strictObject({
  id: z.literal("main"),
  tooltip: tooltipSchema,
  icon: z.enum([
    "app",
    "custom",
  ]),
  showOnLeftClick: z.boolean(),
  menuOnRightClick: z.boolean(),
});
export const trayEventSchema = z.strictObject({
  id: z.literal("main"),
  button: z.enum([
    "left",
    "right",
    "middle",
    "none",
  ]),
  state: z.enum([
    "down",
    "up",
    "double-click",
    "context-menu",
  ]),
  position: positionSchema.nullable(),
});
export const trayEvents = {
  "tray.input": {
    type: "object",
    properties: {
      id: {
        const: "main",
      },
      button: {
        type: "string",
        enum: [
          "left",
          "right",
          "middle",
          "none",
        ],
      },
      state: {
        type: "string",
        enum: [
          "down",
          "up",
          "double-click",
          "context-menu",
        ],
      },
      position: {
        anyOf: [
          {
            const: null,
          },
          {
            type: "object",
            properties: {
              x: {
                type: "integer",
              },
              y: {
                type: "integer",
              },
            },
            required: [
              "x",
              "y",
            ],
            additionalProperties: false,
          },
        ],
      },
    },
    required: [
      "id",
      "button",
      "state",
      "position",
    ],
    additionalProperties: false,
  },
} as const;
