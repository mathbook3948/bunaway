import { BunawayError, type JsonValue, validateValue } from "@bunaway/protocol";
import { fileInput } from "./path.ts";
import { urlInput } from "./url.ts";
/** Selected application paths are validated again by each platform before native execution. */
export const fileWithAppSchema = fileInput.extend({
  app: fileInput.shape.path,
});
export const urlWithAppSchema = urlInput.extend({
  app: fileInput.shape.path,
});
/** Validate a native call, rejecting operations outside this plugin with UNSUPPORTED. */
export function validateOpenerInput(operation: string, input: JsonValue) {
  try {
    switch (operation) {
      case "opener.openUrl":
        return urlInput.parse(validateValue({}, input));
      case "opener.openFile":
      case "opener.revealFile":
      case "opener.trashFile":
        return fileInput.parse(validateValue({}, input));
      case "opener.openFileWith":
        return fileWithAppSchema.parse(validateValue({}, input));
      case "opener.openUrlWith":
        return urlWithAppSchema.parse(validateValue({}, input));
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
