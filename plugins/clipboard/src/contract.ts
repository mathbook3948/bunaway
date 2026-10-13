import { BunawayError, type JsonValue, validateValue } from "@bunaway/protocol";
import { z } from "zod";
import {
  formatSchema,
  imageSchema,
  readFormatsSchema,
  readResultSchema,
  writeFormatsSchema,
} from "./formats.ts";
import { textSchema, writeTextSchema } from "./text.ts";
/** Bounded clipboard access with independent operation permissions. */
export const clipboardOperations = {
  readText: {
    input: z.null(),
    output: z.union([
      textSchema,
      z.null(),
    ]),
  },
  writeText: {
    input: writeTextSchema,
    output: z.null(),
  },
  clear: {
    input: z.null(),
    output: z.null(),
  },
  readImage: {
    input: z.null(),
    output: imageSchema.nullable(),
  },
  writeImage: {
    input: imageSchema,
    output: z.null(),
  },
  getFormats: {
    input: z.null(),
    output: z.array(formatSchema).max(5),
  },
  hasFormat: {
    input: z.strictObject({
      format: formatSchema,
    }),
    output: z.boolean(),
  },
  readFormats: {
    input: readFormatsSchema,
    output: readResultSchema,
  },
  writeFormats: {
    input: writeFormatsSchema,
    output: z.null(),
  },
} as const;
/** Validate a native call before checking UI permission or acquiring the clipboard. */
export function validateClipboardInput(operation: string, input: JsonValue) {
  try {
    switch (operation) {
      case "clipboard.writeText":
        return clipboardOperations.writeText.input.parse(
          validateValue({}, input),
        );
      case "clipboard.writeImage":
        return clipboardOperations.writeImage.input.parse(
          validateValue({}, input),
        );
      case "clipboard.hasFormat":
        return clipboardOperations.hasFormat.input.parse(
          validateValue({}, input),
        );
      case "clipboard.readFormats":
        return clipboardOperations.readFormats.input.parse(
          validateValue({}, input),
        );
      case "clipboard.writeFormats":
        return clipboardOperations.writeFormats.input.parse(
          validateValue({}, input),
        );
      case "clipboard.readImage":
      case "clipboard.getFormats":
      case "clipboard.readText":
      case "clipboard.clear":
        return clipboardOperations.clear.input.parse(validateValue({}, input));
      default:
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "Host operation is not registered.",
        });
    }
  } catch (error) {
    if (error instanceof BunawayError) {
      throw error;
    }
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Invalid plugin input.",
    });
  }
}
