import { z } from "zod";
import { textSchema } from "./text.ts";

/** Supported Windows formats; discovery omits formats this adapter cannot decode. */
export const formatSchema = z.enum([
  "text/plain",
  "text/html",
  "text/rtf",
  "application/x-bunaway-file-list",
  "image/bmp",
]);
export type ClipboardFormat = z.infer<typeof formatSchema>;
export const MAX_IMAGE_BYTES = 524_288;
export const MAX_FORMAT_JSON_BYTES = 900_000;
export const MAX_FILES = 64;
export const MAX_PATH_LENGTH = 1024;

const base64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** JSON carries tightly packed RGBA pixels as canonical base64, without a native resource ID. */
export const imageSchema = z
  .strictObject({
    width: z.number().int().min(1).max(4096),
    height: z.number().int().min(1).max(4096),
    rgba: z
      .string()
      .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
      .regex(base64Pattern),
  })
  .refine((image) => {
    const bytes = image.width * image.height * 4;
    let padding = 0;
    if (image.rgba.endsWith("==")) {
      padding = 2;
    } else if (image.rgba.endsWith("=")) {
      padding = 1;
    }
    const last = alphabet.indexOf(
      image.rgba[image.rgba.length - padding - 1] ?? "",
    );
    return (
      bytes <= MAX_IMAGE_BYTES &&
      (image.rgba.length / 4) * 3 - padding === bytes &&
      (padding === 0 || (last & (padding === 2 ? 15 : 3)) === 0)
    );
  }, "Image dimensions and canonical RGBA bytes must agree.");
export type ClipboardImage = z.infer<typeof imageSchema>;

/** File lists contain local absolute paths; selection does not confer filesystem access. */
export const filesSchema = z
  .array(
    textSchema
      .max(MAX_PATH_LENGTH)
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
// Windows RTF is an ANSI byte stream. Unicode is represented by RTF escapes.
export const rtfSchema = textSchema
  .refine(
    (value) =>
      Array.from(value).every((character) => character.charCodeAt(0) < 128),
    "RTF must use ASCII bytes and Unicode escapes.",
  )
  .regex(/^\{\\rtf[1-9]/);
export const itemSchema = z.discriminatedUnion("format", [
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
    data: filesSchema,
  }),
  z.strictObject({
    format: z.literal("image/bmp"),
    data: imageSchema,
  }),
]);
export type ClipboardItem = z.infer<typeof itemSchema>;

/** Leave room for the protocol envelope even when paths or text require JSON escaping. */
export function fitsFormatBudget(value: unknown): boolean {
  return (
    new TextEncoder().encode(JSON.stringify(value)).byteLength <=
    MAX_FORMAT_JSON_BYTES
  );
}
export const writeFormatsSchema = z
  .strictObject({
    items: z.array(itemSchema).min(1).max(5),
  })
  .refine(
    (input) =>
      new Set(input.items.map((item) => item.format)).size ===
      input.items.length,
    "Formats must be unique.",
  )
  .refine(fitsFormatBudget, "Clipboard data exceeds the transport budget.");
export const readFormatsSchema = z
  .strictObject({
    formats: z.array(formatSchema).min(1).max(5),
  })
  .refine(
    (input) => new Set(input.formats).size === input.formats.length,
    "Formats must be unique.",
  );
export const readResultSchema = z
  .array(
    z.union([
      itemSchema,
      z.strictObject({
        format: formatSchema,
        data: z.null(),
      }),
    ]),
  )
  .max(5)
  .refine(fitsFormatBudget, "Clipboard data exceeds the transport budget.");
