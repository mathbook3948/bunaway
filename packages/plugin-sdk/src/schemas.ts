import { z } from "zod";

/**
 * Shared Zod building blocks for plugin contracts. Plugins declare input bounds with these
 * instead of repeating the lexical rules, so a limit lives in one place and every plugin
 * rejects the same malformed inputs the same way.
 */

/** Standard alphabet, groups of four, with the `=` padding a decoded length requires. */
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$(?![\s\S])/;
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** The number of base64 characters that can encode `bytes` decoded bytes. */
export function base64CharactersFor(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/**
 * Decoded byte length of a canonical base64 string, or null when the text matched the
 * alphabet but is not canonical: the bits of the final sextet that padding leaves unused
 * must be zero, so each byte sequence has exactly one encoding.
 *
 * Callers validate the alphabet and grouping with `BASE64_PATTERN` first.
 */
export function canonicalBase64Bytes(value: string): number | null {
  let padding = 0;
  if (value.endsWith("==")) {
    padding = 2;
  } else if (value.endsWith("=")) {
    padding = 1;
  }
  if (padding !== 0) {
    const last = BASE64_ALPHABET.indexOf(
      value[value.length - padding - 1] ?? "",
    );
    const unusedBits = padding === 2 ? 0b1111 : 0b11;
    if ((last & unusedBits) !== 0) {
      return null;
    }
  }
  return (value.length / 4) * 3 - padding;
}

/**
 * Canonical padded base64 whose decoded length is at most `maxBytes`. The character bound
 * rejects oversized text before the decoded length is computed, and an empty string encodes
 * zero bytes.
 */
export function base64Schema(maxBytes: number, message?: string) {
  return z
    .string()
    .max(base64CharactersFor(maxBytes))
    .regex(BASE64_PATTERN)
    .refine((value) => {
      const bytes = canonicalBase64Bytes(value);
      return bytes !== null && bytes <= maxBytes;
    }, message ??
      "Bytes must use canonical base64 within the decoded size limit.");
}
