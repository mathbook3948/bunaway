import {
  MAX_TRAY_ICO_BYTES,
  MAX_TRAY_TOOLTIP_UNITS,
} from "@bunaway/plugin-api/native";
import { z } from "zod";

const coordinate = z.number().int().min(-2147483648).max(2147483647);
const position = z.strictObject({
  x: coordinate,
  y: coordinate,
});
const tooltip = z
  .string()
  .max(MAX_TRAY_TOOLTIP_UNITS)
  .refine(
    (value) => value.length <= MAX_TRAY_TOOLTIP_UNITS,
    "Tray tooltip exceeds the UTF-16 limit.",
  )
  .regex(/^[^\0\uD800-\uDFFF]*$(?![\s\S])/u);
const ico = z
  .string()
  .min(4)
  .max(Math.ceil(MAX_TRAY_ICO_BYTES / 3) * 4)
  .regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$(?![\s\S])/,
  );
const snapshot = z.strictObject({
  id: z.literal("main"),
  tooltip,
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
  position: position.nullable(),
});
/** Controls for the app's configured tray; each operation has its own permission. */
export const trayOperations = {
  get: {
    input: z.null(),
    output: snapshot.nullable(),
  },
  getBounds: {
    input: z.null(),
    output: position
      .extend({
        width: z.number().int().min(0).max(2147483647),
        height: z.number().int().min(0).max(2147483647),
      })
      .nullable(),
  },
  setTooltip: {
    input: z.strictObject({
      tooltip,
    }),
    output: z.null(),
  },
  setIcon: {
    input: z.strictObject({
      ico: ico.nullable(),
    }),
    output: z.null(),
  },
  setClickBehavior: {
    input: z.strictObject({
      showOnLeftClick: z.boolean(),
      menuOnRightClick: z.boolean(),
    }),
    output: z.null(),
  },
  focus: {
    input: z.null(),
    output: z.boolean(),
  },
  waitForEvent: {
    input: z.null(),
    output: trayEventSchema,
  },
};
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
