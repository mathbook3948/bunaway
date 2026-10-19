import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import {
  type MacosTrayInstance,
  macosMenuClickSchema,
  macosMenuSchema,
  macosStatusItemSchema,
  macosTitleSchema,
  tooltipSchema,
} from "#tray/contract";

const operation = defineNativeOperation<MacosTrayInstance>();
/** Controls for the macOS menu bar item that the app creates and removes itself. */
export const macosTrayOperations = {
  create: operation({
    input: z.strictObject({
      title: macosTitleSchema.default(""),
      tooltip: tooltipSchema.default(""),
    }),
    output: macosStatusItemSchema,
    handler: ({ title, tooltip }, { instance }) =>
      instance.create(title, tooltip),
  }),
  destroy: operation({
    input: z.null(),
    output: z.null(),
    handler: (_input, { instance }) => instance.destroy(),
  }),
  getStatusItem: operation({
    input: z.null(),
    output: macosStatusItemSchema.nullable(),
    handler: (_input, { instance }) => instance.get(),
  }),
  setTitle: operation({
    input: z.strictObject({
      title: macosTitleSchema,
    }),
    output: z.null(),
    handler: ({ title }, { instance }) => instance.setTitle(title),
  }),
  setTooltip: operation({
    input: z.strictObject({
      tooltip: tooltipSchema,
    }),
    output: z.null(),
    handler: ({ tooltip }, { instance }) => instance.setTooltip(tooltip),
  }),
  setMenu: operation({
    input: z.strictObject({
      items: macosMenuSchema.nullable(),
    }),
    output: z.null(),
    handler: ({ items }, { instance }) => instance.setMenu(items),
  }),
  waitForMenuClick: operation({
    input: z.null(),
    output: macosMenuClickSchema,
    handler: (_input, { instance, signal }) =>
      instance.waitForMenuClick(signal),
  }),
};
