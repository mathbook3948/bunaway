import { BunawayError, type JsonValue, validateValue } from "@bunaway/protocol";
import { z } from "zod";
import {
  formatSchema,
  imageSchema,
  readFormatsSchema,
  writeFormatsSchema,
} from "./formats.ts";
import { textSchema, writeTextSchema } from "./text.ts";
export const hasFormatSchema = z.strictObject({
  format: formatSchema,
});
export const nullableTextSchema = textSchema.nullable();
/** Validate a native call before checking UI permission or acquiring the clipboard. */
export function validateClipboardInput(operation: string, input: JsonValue) {
  try {
    switch (operation) {
      case "clipboard.writeText":
        return writeTextSchema.parse(validateValue({}, input));
      case "clipboard.writeImage":
        return imageSchema.parse(validateValue({}, input));
      case "clipboard.hasFormat":
        return hasFormatSchema.parse(validateValue({}, input));
      case "clipboard.readFormats":
        return readFormatsSchema.parse(validateValue({}, input));
      case "clipboard.writeFormats":
        return writeFormatsSchema.parse(validateValue({}, input));
      case "clipboard.readImage":
      case "clipboard.getFormats":
      case "clipboard.readText":
      case "clipboard.clear":
        return z.null().parse(validateValue({}, input));
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
