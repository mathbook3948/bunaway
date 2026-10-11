import { s } from "@bunaway/plugin";
import { BunawayError, type JsonValue, validateValue } from "@bunaway/protocol";
import { textSchema, writeTextSchema } from "./text.ts";

/** Unicode text access and clear-operation contracts. */
export const clipboardOperations = {
  readText: {
    input: s.null(),
    output: {
      anyOf: [
        textSchema,
        s.null(),
      ],
    },
  },
  writeText: {
    input: writeTextSchema,
    output: s.null(),
  },
  clear: {
    input: s.null(),
    output: s.null(),
  },
} as const;

/** Validate a native call before checking UI permission or acquiring the clipboard. */
export function validateClipboardInput(operation: string, input: JsonValue) {
  switch (operation) {
    case "clipboard.writeText":
      return validateValue(clipboardOperations.writeText.input, input);
    case "clipboard.readText":
    case "clipboard.clear":
      return validateValue(clipboardOperations.clear.input, input);
    default:
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Host operation is not registered.",
      });
  }
}
