import { int32Schema } from "@bunaway/plugin";
import {
  MAX_TRAY_ICO_BYTES,
  MAX_TRAY_TOOLTIP_UNITS,
} from "@bunaway/plugin-api/native";
import { z } from "zod";

export const positionSchema = z.strictObject({
  x: int32Schema,
  y: int32Schema,
});
export const tooltipSchema = z
  .string()
  .max(MAX_TRAY_TOOLTIP_UNITS)
  .refine(
    (value) => value.length <= MAX_TRAY_TOOLTIP_UNITS,
    "Tray tooltip exceeds the UTF-16 limit.",
  )
  .regex(/^[^\0\uD800-\uDFFF]*$(?![\s\S])/u);
/** Text without NUL or lone surrogates, which AppKit strings cannot carry. */
const NATIVE_TEXT_PATTERN = /^[^\0\uD800-\uDFFF]*$(?![\s\S])/u;
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
  visible: z.boolean(),
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
/** Pointer hover over the tray icon, derived from shell mouse-move callbacks. */
export const trayHoverEventSchema = z.strictObject({
  state: z.enum([
    "enter",
    "move",
    "leave",
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
  "tray.hover": {
    type: "object",
    properties: {
      state: {
        type: "string",
        enum: [
          "enter",
          "move",
          "leave",
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
      "state",
      "position",
    ],
    additionalProperties: false,
  },
} as const;

/** The macOS menu bar item has no shell-imposed title length; this bounds the allocation. */
export const MAX_MACOS_TRAY_TITLE_UNITS = 256;
export const MAX_MACOS_TRAY_LABEL_UNITS = 256;
export const MAX_MACOS_TRAY_ITEM_ID_LENGTH = 128;
export const MAX_MACOS_TRAY_MENU_ITEMS = 100;
export const macosTitleSchema = z
  .string()
  .max(MAX_MACOS_TRAY_TITLE_UNITS)
  .regex(NATIVE_TEXT_PATTERN);
const macosMenuItemSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("item"),
    id: z.string().min(1).max(MAX_MACOS_TRAY_ITEM_ID_LENGTH),
    label: z
      .string()
      .min(1)
      .max(MAX_MACOS_TRAY_LABEL_UNITS)
      .regex(NATIVE_TEXT_PATTERN),
    enabled: z.boolean().default(true),
  }),
  z.strictObject({
    type: z.literal("separator"),
  }),
]);
/** A flat menu of selectable items and separators. A null menu removes the attached menu. */
export const macosMenuSchema = z
  .array(macosMenuItemSchema)
  .max(MAX_MACOS_TRAY_MENU_ITEMS)
  .refine((items) => {
    const ids = items.flatMap((item) =>
      item.type === "item"
        ? [
            item.id,
          ]
        : [],
    );
    return new Set(ids).size === ids.length;
  }, "Tray menu item ids must be unique.");
export const macosStatusItemSchema = z.strictObject({
  id: z.literal("main"),
  title: macosTitleSchema,
  tooltip: tooltipSchema,
  hasMenu: z.boolean(),
});
export const macosMenuClickSchema = z.strictObject({
  id: z.string(),
});
export type MacosMenuItem = z.output<typeof macosMenuItemSchema>;
export type MacosStatusItem = z.output<typeof macosStatusItemSchema>;
/** Operations of the macOS menu bar item, implemented by the platform adapter. */
export type MacosTrayInstance = {
  create(title: string, tooltip: string): MacosStatusItem;
  destroy(): null;
  get(): MacosStatusItem | null;
  setTitle(title: string): null;
  setTooltip(tooltip: string): null;
  setMenu(items: readonly MacosMenuItem[] | null): null;
  waitForMenuClick(
    signal?: AbortSignal,
  ): Promise<z.output<typeof macosMenuClickSchema>>;
};
