import { z } from "zod";
/** Maximum Unicode scalar values accepted in either direction. */
export const MAX_TEXT_LENGTH = 16_384;
const TEXT_PATTERN = "^[^\\u0000\\uD800-\\uDFFF]*$(?![\\s\\S])";
/** NUL cannot occur inside CF_UNICODETEXT; isolated surrogates are not Unicode text. */
export const textSchema = z
  .string()
  .max(MAX_TEXT_LENGTH)
  .regex(new RegExp(TEXT_PATTERN, "u"));
export const writeTextSchema = z.strictObject({
  text: textSchema,
});
