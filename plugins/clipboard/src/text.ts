import { s } from "@bunaway/plugin";

/** Maximum Unicode scalar values accepted in either direction. */
export const MAX_TEXT_LENGTH = 16_384;
/** NUL cannot occur inside CF_UNICODETEXT; isolated surrogates are not Unicode text. */
export const textSchema = s.string({
  maxLength: MAX_TEXT_LENGTH,
  pattern: "^[^\\u0000\\uD800-\\uDFFF]*$(?![\\s\\S])",
});
export const writeTextSchema = s.object({
  text: textSchema,
});
