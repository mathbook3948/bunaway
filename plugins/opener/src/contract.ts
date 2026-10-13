import { BunawayError, type JsonValue, validateValue } from "@bunaway/protocol";
import { z } from "zod";
import { fileInput } from "./path.ts";
import { urlInput } from "./url.ts";
/** File and HTTP or HTTPS request contracts shared by callers and native execution. */
export const openerOperations = {
  openUrl: {
    input: urlInput,
    output: z.null(),
  },
  openFile: {
    input: fileInput,
    output: z.null(),
  },
  trashFile: {
    input: fileInput,
    output: z.null(),
  },
  revealFile: {
    input: fileInput,
    output: z.null(),
  },
  openFileWith: {
    input: fileInput.extend({
      app: fileInput.shape.path,
    }),
    output: z.null(),
  },
  openUrlWith: {
    input: urlInput.extend({
      app: fileInput.shape.path,
    }),
    output: z.null(),
  },
} as const;
/** Validate a native call, rejecting operations outside this plugin with UNSUPPORTED. */
export function validateOpenerInput(operation: string, input: JsonValue) {
  try {
    switch (operation) {
      case "opener.openUrl":
        return openerOperations.openUrl.input.parse(validateValue({}, input));
      case "opener.openFile":
      case "opener.revealFile":
      case "opener.trashFile":
        return openerOperations.openFile.input.parse(validateValue({}, input));
      case "opener.openFileWith":
        return openerOperations.openFileWith.input.parse(
          validateValue({}, input),
        );
      case "opener.openUrlWith":
        return openerOperations.openUrlWith.input.parse(
          validateValue({}, input),
        );
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
