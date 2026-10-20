import { base64Schema, canonicalBase64Bytes } from "@bunaway/plugin";
import { BunawayError, type JsonValue, validateValue } from "@bunaway/protocol";
import { z } from "zod";
/** Maximum Unicode scalar values accepted in either direction. */
export const MAX_TEXT_LENGTH = 16_384;
const TEXT_PATTERN = "^[^\\u0000\\uD800-\\uDFFF]*$(?![\\s\\S])";
/** NUL cannot occur inside CF_UNICODETEXT; isolated surrogates are not Unicode text. */
export const textSchema = z
  .string()
  .refine(
    (value) => Array.from(value).length <= MAX_TEXT_LENGTH,
    "Text exceeds the Unicode character limit.",
  )
  .regex(new RegExp(TEXT_PATTERN, "u"));
export const writeTextSchema = z.strictObject({
  text: textSchema,
});

/** Built-in discovery omits arbitrary registered names. */
export const builtInFormatSchema = z.enum([
  "text/plain",
  "text/html",
  "text/rtf",
  "application/x-bunaway-file-list",
  "image/bmp",
  "application/x-bunaway-bookmark",
]);
/** Private registered names cannot alias Windows formats with other ownership rules. */
export const binaryFormatSchema = z.templateLiteral([
  "application/x-bunaway-binary/",
  z.string().regex(/^[a-z][a-z0-9._-]{0,63}$(?![\s\S])/),
]);
export const formatSchema = z.union([
  builtInFormatSchema,
  binaryFormatSchema,
]);
export type ClipboardFormat = z.infer<typeof formatSchema>;
export const MAX_IMAGE_BYTES = 524_288;
export const MAX_IMAGE_DIMENSION = 4096;
export const MAX_FORMAT_JSON_BYTES = 900_000;
export const MAX_FILES = 64;
export const MAX_PATH_LENGTH = 1024;

export const MAX_BINARY_BYTES = 262_144;
export const MAX_BINARY_FORMATS = 64;
export const MAX_BOOKMARK_LENGTH = 2048;
/** Opaque bytes use canonical base64, including the empty string for zero bytes. */
export const binarySchema = base64Schema(
  MAX_BINARY_BYTES,
  "Binary data must be bounded canonical base64.",
);
/** A Windows URL bookmark has no title and never opens the URL. */
export const bookmarkSchema = z.strictObject({
  url: textSchema
    .max(MAX_BOOKMARK_LENGTH)
    .refine(
      (url) => url.length <= MAX_BOOKMARK_LENGTH,
      "URLs cannot exceed the UTF-16 code unit limit.",
    )
    .regex(/^[Hh][Tt][Tt][Pp][Ss]?:\/\/[^\s]+$(?![\s\S])/u)
    .refine((value) => {
      try {
        if (
          Array.from(value).some(
            (character) =>
              character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          )
        ) {
          return false;
        }
        const url = new URL(value);
        return (
          (url.protocol === "https:" || url.protocol === "http:") &&
          url.hostname !== ""
        );
      } catch {
        return false;
      }
    }, "Bookmarks require an absolute HTTP or HTTPS URL."),
});
/** JSON carries tightly packed RGBA pixels as canonical base64, without a native resource ID. */
export const imageSchema = z
  .strictObject({
    width: z.number().int().min(1).max(MAX_IMAGE_DIMENSION),
    height: z.number().int().min(1).max(MAX_IMAGE_DIMENSION),
    rgba: base64Schema(MAX_IMAGE_BYTES),
  })
  .refine((image) => {
    const bytes = image.width * image.height * 4;
    return (
      bytes <= MAX_IMAGE_BYTES && canonicalBase64Bytes(image.rgba) === bytes
    );
  }, "Image dimensions and canonical RGBA bytes must agree.");
export type ClipboardImage = z.infer<typeof imageSchema>;

/** File lists contain local absolute paths; selection does not confer filesystem access. */
export const filesSchema = z
  .array(
    textSchema
      .refine(
        (path) => path.length <= MAX_PATH_LENGTH,
        "Paths cannot exceed the UTF-16 code unit limit.",
      )
      .regex(/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))/u)
      .regex(/^[^<>"|?*]*$/u)
      .refine(
        (path) =>
          Array.from(path).every((character) => character.charCodeAt(0) >= 32),
        "Paths cannot contain control characters.",
      )
      .refine(
        (path) => !path.startsWith("\\\\.\\"),
        "Device paths are unsupported.",
      ),
  )
  .min(1)
  .max(MAX_FILES);
/** macOS file lists contain absolute POSIX paths; `file://` URLs are not accepted as input. */
export const posixFilesSchema = z
  .array(
    textSchema
      .refine(
        (path) => path.length <= MAX_PATH_LENGTH,
        "Paths cannot exceed the UTF-16 code unit limit.",
      )
      .regex(/^\//u)
      .refine(
        (path) =>
          Array.from(path).every(
            (character) =>
              character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
          ),
        "Paths cannot contain control characters.",
      ),
  )
  .min(1)
  .max(MAX_FILES);
// Windows RTF is an ANSI byte stream. Unicode is represented by RTF escapes.
export const rtfSchema = textSchema
  .refine(
    (value) =>
      Array.from(value).every((character) => character.charCodeAt(0) < 128),
    "RTF must use ASCII bytes and Unicode escapes.",
  )
  .regex(/^\{\\rtf[1-9]/);
const createItemSchema = (
  files: typeof filesSchema | typeof posixFilesSchema,
) => {
  const builtInItemSchema = z.discriminatedUnion("format", [
    z.strictObject({
      format: z.literal("text/plain"),
      data: textSchema,
    }),
    z.strictObject({
      format: z.literal("text/html"),
      data: textSchema,
    }),
    z.strictObject({
      format: z.literal("text/rtf"),
      data: rtfSchema,
    }),
    z.strictObject({
      format: z.literal("application/x-bunaway-file-list"),
      data: files,
    }),
    z.strictObject({
      format: z.literal("image/bmp"),
      data: imageSchema,
    }),
    z.strictObject({
      format: z.literal("application/x-bunaway-bookmark"),
      data: bookmarkSchema,
    }),
  ]);
  return z.union([
    builtInItemSchema,
    z.strictObject({
      format: binaryFormatSchema,
      data: binarySchema,
    }),
  ]);
};
export const itemSchema = createItemSchema(filesSchema);
export const macosItemSchema = createItemSchema(posixFilesSchema);
export type ClipboardItem = z.infer<typeof itemSchema>;
export type MacosClipboardItem = z.infer<typeof macosItemSchema>;

/** Leave room for the protocol envelope even when paths or text require JSON escaping. */
export function fitsFormatBudget(value: unknown): boolean {
  return (
    new TextEncoder().encode(JSON.stringify(value)).byteLength <=
    MAX_FORMAT_JSON_BYTES
  );
}
const createWriteFormatsSchema = (item: typeof itemSchema) =>
  z
    .strictObject({
      items: z.array(item).min(1).max(5),
    })
    .refine(
      (input) =>
        new Set(input.items.map((entry) => entry.format)).size ===
        input.items.length,
      "Formats must be unique.",
    )
    .refine(fitsFormatBudget, "Clipboard data exceeds the transport budget.");
export const writeFormatsSchema = createWriteFormatsSchema(itemSchema);
export const macosWriteFormatsSchema =
  createWriteFormatsSchema(macosItemSchema);
export const readFormatsSchema = z
  .strictObject({
    formats: z.array(formatSchema).min(1).max(5),
  })
  .refine(
    (input) => new Set(input.formats).size === input.formats.length,
    "Formats must be unique.",
  );
const createReadResultSchema = (item: typeof itemSchema) =>
  z
    .array(
      z.union([
        item,
        z.strictObject({
          format: formatSchema,
          data: z.null(),
        }),
      ]),
    )
    .max(5)
    .refine(fitsFormatBudget, "Clipboard data exceeds the transport budget.");
export const readResultSchema = createReadResultSchema(itemSchema);
export const macosReadResultSchema = createReadResultSchema(macosItemSchema);

export const hasFormatSchema = z.strictObject({
  format: formatSchema,
});
export const nullableTextSchema = textSchema.nullable();
/** Concurrent `waitForChange` calls accepted per adapter. */
export const MAX_CHANGE_WAITERS = 16;
const MAX_SEQUENCE = 0xffff_ffff;
/**
 * Content-free change notification. `sequence` is the Windows clipboard sequence number
 * (an unsigned 32-bit counter that wraps) and `changedAt` is the observation time in Unix
 * epoch milliseconds.
 */
export const changeSchema = z.strictObject({
  sequence: z.number().int().min(0).max(MAX_SEQUENCE),
  changedAt: z.number().int().min(0),
});
export type ClipboardChange = z.output<typeof changeSchema>;
export const clipboardEvents = {
  "clipboard.changed": {
    payload: {
      type: "object",
      properties: {
        sequence: {
          type: "integer",
          minimum: 0,
          maximum: MAX_SEQUENCE,
        },
        changedAt: {
          type: "integer",
          minimum: 0,
        },
      },
      required: [
        "sequence",
        "changedAt",
      ],
      additionalProperties: false,
    },
  },
} as const;

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
      case "clipboard.waitForChange":
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
