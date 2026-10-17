import { BunawayError, type JsonValue, validateValue } from "@bunaway/protocol";
import { z } from "zod";

// Explorer's file operations use ordinary Win32 paths, not extended device paths.
export const MAX_FILE_PATH_LENGTH = 259;
export const fileInput = z.strictObject({
  path: z
    .string()
    .refine(
      (value) => Array.from(value).length <= MAX_FILE_PATH_LENGTH,
      "Text exceeds the Unicode character limit.",
    ),
});

/** Operations without parameters accept only an empty object. */
export const emptyInput = z.strictObject({});

export const MAX_URL_LENGTH = 8192;
export const urlInput = z.strictObject({
  url: z
    .string()
    .refine(
      (value) => Array.from(value).length <= MAX_URL_LENGTH,
      "Text exceeds the Unicode character limit.",
    ),
});

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
      case "opener.addRecentDocument":
        return fileInput.parse(validateValue({}, input));
      case "opener.clearRecentDocuments":
        return emptyInput.parse(validateValue({}, input));
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
