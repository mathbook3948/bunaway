import { base64Schema, int32Schema } from "@bunaway/plugin";
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
/** NOTIFYICONDATAW.szInfoTitle holds 64 WCHAR including the terminating NUL. */
export const MAX_TRAY_BALLOON_TITLE_UNITS = 63;
/** NOTIFYICONDATAW.szInfo holds 256 WCHAR including the terminating NUL. */
export const MAX_TRAY_BALLOON_CONTENT_UNITS = 255;
/** Native text of at most `maxUnits` UTF-16 units; zod's own `max` counts code points. */
function balloonText(maxUnits: number, minUnits: number) {
  return z
    .string()
    .min(minUnits)
    .regex(NATIVE_TEXT_PATTERN)
    .refine(
      (value) => value.length <= maxUnits,
      "Tray balloon text exceeds the UTF-16 limit.",
    );
}
/**
 * A balloon notification anchored to the tray icon. Lengths count UTF-16 units. `iconType` picks
 * the stock icon beside the title. `silent` suppresses the notification sound.
 */
export const balloonSchema = z.strictObject({
  title: balloonText(MAX_TRAY_BALLOON_TITLE_UNITS, 0),
  content: balloonText(MAX_TRAY_BALLOON_CONTENT_UNITS, 1),
  iconType: z
    .enum([
      "none",
      "info",
      "warning",
      "error",
    ])
    .default("none"),
  silent: z.boolean().default(false),
});
export type TrayBalloon = z.output<typeof balloonSchema>;
/**
 * Balloon lifecycle reported by the shell. `closed` covers timeout, dismissal and removal, so one
 * shown balloon yields at most one `closed`.
 */
export const trayBalloonEventSchema = z.strictObject({
  state: z.enum([
    "show",
    "click",
    "closed",
  ]),
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
  "tray.balloon": {
    type: "object",
    properties: {
      state: {
        type: "string",
        enum: [
          "show",
          "click",
          "closed",
        ],
      },
    },
    required: [
      "state",
    ],
    additionalProperties: false,
  },
} as const;

/** The macOS menu bar item has no shell-imposed title length; this bounds the allocation. */
export const MAX_MACOS_TRAY_TITLE_UNITS = 256;
export const MAX_MACOS_TRAY_LABEL_UNITS = 256;
export const MAX_MACOS_TRAY_ITEM_ID_LENGTH = 128;
export const MAX_MACOS_TRAY_MENU_ITEMS = 100;
/** Menu bar images are 18 to 22 points tall; the byte bound keeps decoding cheap. */
export const MAX_MACOS_TRAY_IMAGE_BYTES = 256 * 1024;
/** Longest PNG side in pixels, 22 points at 2x with room to spare. */
export const MAX_MACOS_TRAY_IMAGE_SIDE_PIXELS = 512;
export const macosTitleSchema = z
  .string()
  .max(MAX_MACOS_TRAY_TITLE_UNITS)
  .regex(NATIVE_TEXT_PATTERN);
/**
 * A PNG for the menu bar button. `scale` is the pixel density the PNG was drawn for, so a 2x image
 * of 44 by 44 pixels shows at 22 by 22 points. `template` lets macOS tint the image for the light
 * and dark menu bar and for highlighting, using only its alpha channel. `description` is the
 * accessibility name VoiceOver reads for the image.
 */
export const macosImageSchema = z.strictObject({
  png: base64Schema(MAX_MACOS_TRAY_IMAGE_BYTES).min(4),
  template: z.boolean().default(false),
  scale: z
    .union([
      z.literal(1),
      z.literal(2),
    ])
    .default(1),
  description: macosTitleSchema.default(""),
});
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
  hasImage: z.boolean(),
});
export const macosMenuClickSchema = z.strictObject({
  id: z.string(),
});
export type MacosMenuItem = z.output<typeof macosMenuItemSchema>;
export type MacosImage = z.output<typeof macosImageSchema>;
export type MacosStatusItem = z.output<typeof macosStatusItemSchema>;
/** Operations of the macOS menu bar item, implemented by the platform adapter. */
export type MacosTrayInstance = {
  create(title: string, tooltip: string): MacosStatusItem;
  destroy(): null;
  get(): MacosStatusItem | null;
  setTitle(title: string): null;
  setTooltip(tooltip: string): null;
  setMenu(items: readonly MacosMenuItem[] | null): null;
  setImage(image: MacosImage | null): null;
  waitForMenuClick(
    signal?: AbortSignal,
  ): Promise<z.output<typeof macosMenuClickSchema>>;
};
