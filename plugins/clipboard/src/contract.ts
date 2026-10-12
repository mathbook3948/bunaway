import { BunawayError, type JsonValue, validateValue } from "@bunaway/protocol";
import { z } from "zod";
import { textSchema, writeTextSchema } from "./text.ts";
/** Unicode text access and clear-operation contracts. */
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
} as const;
/** Validate a native call before checking UI permission or acquiring the clipboard. */
export function validateClipboardInput(operation: string, input: JsonValue) {
  try {
    switch (operation) {
      case "clipboard.writeText":
        return clipboardOperations.writeText.input.parse(
          validateValue({}, input),
        );
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
