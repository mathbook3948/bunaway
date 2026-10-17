import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import {
  builtInFormatSchema,
  changeSchema,
  hasFormatSchema,
  imageSchema,
  nullableTextSchema,
  readFormatsSchema,
  readResultSchema,
  writeFormatsSchema,
  writeTextSchema,
} from "#clipboard/contract";
import type { MacosClipboard } from "#clipboard/platforms/macos";
import type { WindowsClipboard } from "#clipboard/platforms/windows";

const macosOperation = defineNativeOperation<MacosClipboard>();
const windowsOperation = defineNativeOperation<WindowsClipboard>();
/** macOS calls are synchronous; Windows handlers propagate cancellation through clipboard retries. */
export const macosOperations = {
  readText: macosOperation({
    input: z.null(),
    output: nullableTextSchema,
    handler: (_input, { instance }) => instance.readText(),
  }),
  writeText: macosOperation({
    input: writeTextSchema,
    output: z.null(),
    handler: ({ text }, { instance }) => instance.writeText(text),
  }),
  clear: macosOperation({
    input: z.null(),
    output: z.null(),
    handler: (_input, { instance }) => instance.clear(),
  }),
  readImage: macosOperation({
    input: z.null(),
    output: imageSchema.nullable(),
    handler: (_input, { instance }) => instance.readImage(),
  }),
  writeImage: macosOperation({
    input: imageSchema,
    output: z.null(),
    handler: (input, { instance }) => instance.writeImage(input),
  }),
  getFormats: macosOperation({
    input: z.null(),
    output: z
      .array(builtInFormatSchema)
      .max(builtInFormatSchema.options.length),
    handler: (_input, { instance }) => instance.getFormats(),
  }),
  hasFormat: macosOperation({
    input: hasFormatSchema,
    output: z.boolean(),
    handler: ({ format }, { instance }) => instance.hasFormat(format),
  }),
  readFormats: macosOperation({
    input: readFormatsSchema,
    output: readResultSchema,
    handler: ({ formats }, { instance }) => instance.readFormats(formats),
  }),
  writeFormats: macosOperation({
    input: writeFormatsSchema,
    output: z.null(),
    handler: ({ items }, { instance }) => instance.writeFormats(items),
  }),
};
export const windowsOperations = {
  readText: windowsOperation({
    input: z.null(),
    output: nullableTextSchema,
    handler: (_input, { instance, signal }) => instance.readText(signal),
  }),
  writeText: windowsOperation({
    input: writeTextSchema,
    output: z.null(),
    handler: ({ text }, { instance, signal }) =>
      instance.writeText(text, signal),
  }),
  clear: windowsOperation({
    input: z.null(),
    output: z.null(),
    handler: (_input, { instance, signal }) => instance.clear(signal),
  }),
  readImage: windowsOperation({
    input: z.null(),
    output: imageSchema.nullable(),
    handler: (_input, { instance, signal }) => instance.readImage(signal),
  }),
  writeImage: windowsOperation({
    input: imageSchema,
    output: z.null(),
    handler: (input, { instance, signal }) =>
      instance.writeImage(input, signal),
  }),
  getFormats: windowsOperation({
    input: z.null(),
    output: z
      .array(builtInFormatSchema)
      .max(builtInFormatSchema.options.length),
    handler: (_input, { instance, signal }) => instance.getFormats(signal),
  }),
  hasFormat: windowsOperation({
    input: hasFormatSchema,
    output: z.boolean(),
    handler: ({ format }, { instance, signal }) =>
      instance.hasFormat(format, signal),
  }),
  readFormats: windowsOperation({
    input: readFormatsSchema,
    output: readResultSchema,
    handler: ({ formats }, { instance, signal }) =>
      instance.readFormats(formats, signal),
  }),
  writeFormats: windowsOperation({
    input: writeFormatsSchema,
    output: z.null(),
    handler: ({ items }, { instance, signal }) =>
      instance.writeFormats(items, signal),
  }),
  waitForChange: windowsOperation({
    input: z.null(),
    output: changeSchema,
    handler: (_input, { instance, signal }) => instance.waitForChange(signal),
  }),
};
