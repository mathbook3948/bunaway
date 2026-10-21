import { base64Schema, int32Schema } from "@bunaway/plugin";
import { BunawayError, type JsonValue, validateValue } from "@bunaway/protocol";
import { z } from "zod";
import { isRegistrableUrlScheme } from "#opener/url-scheme";

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

/** A URL scheme to register, in any letter case; platforms use its lowercase form. */
export const urlSchemeInput = z.strictObject({
  scheme: z
    .string()
    .refine(isRegistrableUrlScheme, "Expected an unreserved URL scheme."),
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
// IShellLinkW::SetDescription keeps at most 260 UTF-16 code units and silently drops the rest.
export const MAX_SHORTCUT_DESCRIPTION_LENGTH = 260;
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
      (value) => value.length <= limit,
      "Text exceeds the UTF-16 code unit limit.",
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
  iconIndex: int32Schema.optional(),
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

// The Shell shows only as many Jump List entries as the user's settings allow and drops the rest
// without an error; these bounds only limit the size of one request.
export const MAX_JUMP_LIST_CATEGORIES = 20;
export const MAX_JUMP_LIST_ITEMS = 100;
export const MAX_JUMP_LIST_ARGUMENTS = 64;
export const MAX_JUMP_LIST_TITLE_LENGTH = 260;
export const MAX_JUMP_LIST_CATEGORY_NAME_LENGTH = 260;

/** One program argument; `%` is rejected because the Shell expands placeholders even inside quotes. */
const jumpListArgument = shortcutText(MAX_SHORTCUT_ARGUMENTS_LENGTH).refine(
  (value) => !value.includes("%"),
  "Text contains a percent sign.",
);
const nonEmpty = (value: string) => value.length > 0;

/** A task starts this app again with the given arguments; the program itself is never chosen by the caller. */
export const jumpListTaskSchema = z.strictObject({
  type: z.literal("task"),
  title: shortcutText(MAX_JUMP_LIST_TITLE_LENGTH).refine(
    nonEmpty,
    "Text is empty.",
  ),
  args: z.array(jumpListArgument).max(MAX_JUMP_LIST_ARGUMENTS).optional(),
  description: shortcutText(MAX_SHORTCUT_DESCRIPTION_LENGTH).optional(),
  iconPath: fileInput.shape.path.optional(),
  iconIndex: int32Schema.optional(),
  cwd: fileInput.shape.path.optional(),
});
export type JumpListTask = z.infer<typeof jumpListTaskSchema>;
const jumpListSeparatorSchema = z.strictObject({
  type: z.literal("separator"),
});
export type JumpListSeparator = z.infer<typeof jumpListSeparatorSchema>;

/** The Tasks section holds tasks and separators; a custom category holds tasks only. */
const jumpListCategorySchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("tasks"),
    items: z
      .array(
        z.union([
          jumpListTaskSchema,
          jumpListSeparatorSchema,
        ]),
      )
      .min(1),
  }),
  z.strictObject({
    type: z.literal("custom"),
    name: shortcutText(MAX_JUMP_LIST_CATEGORY_NAME_LENGTH).refine(
      nonEmpty,
      "Text is empty.",
    ),
    items: z.array(jumpListTaskSchema).min(1),
  }),
]);
export type JumpListCategory = z.infer<typeof jumpListCategorySchema>;

export const jumpListInput = z.strictObject({
  categories: z
    .array(jumpListCategorySchema)
    .min(1)
    .max(MAX_JUMP_LIST_CATEGORIES)
    .refine(
      (categories) =>
        categories.filter((category) => category.type === "tasks").length <= 1,
      "Expected at most one tasks category.",
    )
    .refine(
      (categories) =>
        categories.reduce(
          (total, category) => total + category.items.length,
          0,
        ) <= MAX_JUMP_LIST_ITEMS,
      "Too many Jump List items.",
    ),
});
export type JumpListInput = z.infer<typeof jumpListInput>;

/** `customCategoryAccessDenied`: the Shell refused custom categories, for example when recent items are turned off. */
export const jumpListResultSchema = z.enum([
  "ok",
  "customCategoryAccessDenied",
]);
export type JumpListResult = z.infer<typeof jumpListResultSchema>;

/** A task the user removed from the list; unset text properties are empty strings. */
export const removedJumpListTaskSchema = z.strictObject({
  type: z.literal("task"),
  title: z.string(),
  args: z.array(z.string()),
  description: z.string(),
  iconPath: z.string(),
  iconIndex: z.number().int(),
  cwd: z.string(),
});
export type RemovedJumpListTask = z.infer<typeof removedJumpListTaskSchema>;

export const FILE_ICON_SIZES = [
  "small",
  "normal",
  "large",
] as const;
export type FileIconSize = (typeof FILE_ICON_SIZES)[number];
export const DEFAULT_FILE_ICON_SIZE: FileIconSize = "normal";
export const MAX_FILE_ICON_EXTENSION_LENGTH = 31;
// Shell icon lists top out at 256 pixels at any display scale.
export const MAX_FILE_ICON_EDGE_PIXELS = 256;
// An uncompressed 256 by 256 RGBA PNG is about 256 KiB; the limit leaves room for incompressible data.
export const MAX_FILE_ICON_PNG_BYTES = 512 * 1024;
const fileIconSize = z.enum(FILE_ICON_SIZES);

/**
 * A file extension such as `.txt`: a dot and at most 31 letters, digits, `_`, `-`, `+` or `~`.
 * Anything that could name a path, a stream or another file is rejected.
 */
export const fileIconExtension = z
  .string()
  .regex(
    new RegExp(`^\\.[A-Za-z0-9_+~-]{1,${MAX_FILE_ICON_EXTENSION_LENGTH}}$`),
    "Expected a file extension such as .txt.",
  );

/**
 * The icon of an existing file (`path`) or the icon registered for an extension, without a file.
 * `size` is `small` (16), `normal` (32, the default) or `large` (48) pixels at 100% scale.
 */
export const fileIconInput = z.union([
  fileInput.extend({
    size: fileIconSize.optional(),
  }),
  z.strictObject({
    extension: fileIconExtension,
    size: fileIconSize.optional(),
  }),
]);
export type FileIconInput = z.infer<typeof fileIconInput>;

/** A shell icon as a PNG with alpha. `width` and `height` are the actual pixels, larger when the display is scaled. */
export const fileIconSchema = z.strictObject({
  mime: z.literal("image/png"),
  data: base64Schema(MAX_FILE_ICON_PNG_BYTES),
  width: z.number().int().min(1).max(MAX_FILE_ICON_EDGE_PIXELS),
  height: z.number().int().min(1).max(MAX_FILE_ICON_EDGE_PIXELS),
});
export type FileIcon = z.infer<typeof fileIconSchema>;

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
      case "opener.registerUrlScheme":
      case "opener.unregisterUrlScheme":
      case "opener.isUrlSchemeRegistered":
        return urlSchemeInput.parse(validateValue({}, input));
      case "opener.openFile":
      case "opener.readShortcutLink":
      case "opener.revealFile":
      case "opener.trashFile":
      case "opener.addRecentDocument":
        return fileInput.parse(validateValue({}, input));
      case "opener.getFileIcon":
        return fileIconInput.parse(validateValue({}, input));
      case "opener.writeShortcutLink":
        return shortcutWriteInput.parse(validateValue({}, input));
      case "opener.setJumpList":
        return jumpListInput.parse(validateValue({}, input));
      case "opener.getJumpListRemovedItems":
      case "opener.deleteJumpList":
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
