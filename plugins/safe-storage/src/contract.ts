import { base64Schema } from "@bunaway/plugin";
import { z } from "zod";

const MAX_PLAINTEXT_BYTES = 256 * 1024;
const MAX_CIPHERTEXT_BYTES = 384 * 1024;
const MAX_TEXT_CHARACTERS = 32 * 1024;

/** Bounded canonical base64, with zero padding bits and no whitespace. */
export const plaintextSchema = base64Schema(MAX_PLAINTEXT_BYTES);
export const ciphertextSchema = base64Schema(MAX_CIPHERTEXT_BYTES).min(4);
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
