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
  revealFile: {
    input: fileInput,
    output: z.null(),
  },
} as const;
/** Validate a native call, rejecting operations outside this plugin with UNSUPPORTED. */
export function validateOpenerInput(operation: string, input: JsonValue) {
  switch (operation) {
    case "opener.openUrl":
      return validateValue(openerOperations.openUrl.input, input);
    case "opener.openFile":
    case "opener.revealFile":
      return validateValue(openerOperations.openFile.input, input);
    default:
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Host operation is not registered.",
      });
  }
}
