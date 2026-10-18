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

/**
 * Application registered for a URL scheme. `name` is the display name and `path` the
 * executable path; both are non-empty Shell text without control characters.
 */
export const urlHandlerSchema = z.strictObject({
  name: z.string().min(1),
  path: z.string().min(1),
});
export type UrlHandler = z.infer<typeof urlHandlerSchema>;

export const MAX_SHORTCUT_ARGUMENTS_LENGTH = 2048;
// INFOTIPSIZE: the longest description the Shell keeps for a shortcut.
export const MAX_SHORTCUT_DESCRIPTION_LENGTH = 1024;
export const SHORTCUT_OPERATIONS = [
  "create",
  "update",
  "replace",
] as const;
export type ShortcutOperation = (typeof SHORTCUT_OPERATIONS)[number];

const shortcutText = (limit: number) =>
  z
    .string()
    .refine(
      (value) => Array.from(value).length <= limit,
      "Text exceeds the Unicode character limit.",
    )
    .refine(
      (value) => !/[\p{Cc}\p{Cs}]/u.test(value),
      "Text contains control characters.",
    );

/**
 * Shortcut properties. A write applies only the fields it names; `create` and `replace`
 * start from an empty link, so they require `target`. Paths are absolute Windows paths.
 */
export const shortcutDetailsSchema = z.strictObject({
  target: fileInput.shape.path.optional(),
  cwd: fileInput.shape.path.optional(),
  args: shortcutText(MAX_SHORTCUT_ARGUMENTS_LENGTH).optional(),
  description: shortcutText(MAX_SHORTCUT_DESCRIPTION_LENGTH).optional(),
  icon: fileInput.shape.path.optional(),
  iconIndex: z.number().int().min(-0x80000000).max(0x7fffffff).optional(),
});
export type ShortcutDetails = z.infer<typeof shortcutDetailsSchema>;

export const shortcutWriteInput = fileInput.extend({
  operation: z.enum(SHORTCUT_OPERATIONS),
  details: shortcutDetailsSchema,
});

/** Shortcut properties as stored; an unset text property is an empty string, as in Electron. */
export const shortcutLinkSchema = z.strictObject({
  target: z.string(),
  cwd: z.string(),
  args: z.string(),
  description: z.string(),
  icon: z.string(),
  iconIndex: z.number().int(),
});
export type ShortcutLink = z.infer<typeof shortcutLinkSchema>;

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
      case "opener.getUrlHandler":
        return urlInput.parse(validateValue({}, input));
      case "opener.openFile":
      case "opener.readShortcutLink":
      case "opener.revealFile":
      case "opener.trashFile":
      case "opener.addRecentDocument":
        return fileInput.parse(validateValue({}, input));
      case "opener.writeShortcutLink":
        return shortcutWriteInput.parse(validateValue({}, input));
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
