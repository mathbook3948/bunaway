import { z } from "zod";

const MAX_PLAINTEXT_BYTES = 256 * 1024;
const MAX_CIPHERTEXT_BYTES = 384 * 1024;
const MAX_TEXT_CHARACTERS = 32 * 1024;

/** Bounded canonical base64, with zero padding bits and no whitespace. */
function base64(maxBytes: number) {
  return z
    .string()
    .max(4 * Math.ceil(maxBytes / 3))
    .regex(
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$(?![\s\S])/,
    )
    .refine(
      (value) =>
        (value.length / 4) * 3 -
          (value.endsWith("==") ? 2 : Number(value.endsWith("="))) <=
        maxBytes,
    );
}

export const plaintextSchema = base64(MAX_PLAINTEXT_BYTES);
export const ciphertextSchema = base64(MAX_CIPHERTEXT_BYTES).min(4);
// The transport bound is in UTF-16 units. Zod string max counts code points,
// so retain its coarse bound and enforce JavaScript string length for both directions.
export const textSchema = z
  .string()
  .max(MAX_TEXT_CHARACTERS)
  .refine(
    (value) => value.length <= MAX_TEXT_CHARACTERS,
    "Text exceeds the UTF-16 code unit limit.",
  );

/** Shared value schemas; each operation still declares its own input and output. */
export const textInputSchema = z.strictObject({
  text: textSchema,
});
export const bytesInputSchema = z.strictObject({
  bytes: plaintextSchema,
});
export const ciphertextInputSchema = z.strictObject({
  ciphertext: ciphertextSchema,
});

/** Common instance shape chosen by this plugin because both platforms expose the same operations. */
export interface SafeStorageInstance {
  isAvailable(): boolean;
  encryptString(text: string): string;
  decryptString(ciphertext: string): string;
  encryptBytes(bytes: string): string;
  decryptBytes(ciphertext: string): string;
}

/** Bounds also applied to native buffers before allocation or copying. */
export const safeStorageLimits = {
  plaintextBytes: MAX_PLAINTEXT_BYTES,
  ciphertextBytes: MAX_CIPHERTEXT_BYTES,
  textCharacters: MAX_TEXT_CHARACTERS,
};
