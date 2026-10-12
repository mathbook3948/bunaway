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

const plaintext = base64(MAX_PLAINTEXT_BYTES);
const ciphertext = base64(MAX_CIPHERTEXT_BYTES).min(4);
// The text bound covers UTF-8 and even worst-case JSON escaping in the host transport.
const text = z.string().max(MAX_TEXT_CHARACTERS);

/** Current-user Windows DPAPI operations. Each has a separate policy grant. */
export const safeStorageOperations = {
  isAvailable: {
    input: z.null(),
    output: z.boolean(),
  },
  encryptString: {
    input: z.strictObject({
      text,
    }),
    output: ciphertext,
  },
  decryptString: {
    input: z.strictObject({
      ciphertext,
    }),
    output: text,
  },
  encryptBytes: {
    input: z.strictObject({
      bytes: plaintext,
    }),
    output: ciphertext,
  },
  decryptBytes: {
    input: z.strictObject({
      ciphertext,
    }),
    output: plaintext,
  },
} as const;

/** Parsed native input, carried after the SDK validates JSON and Zod contracts. */
export type SafeStorageInput = z.infer<
  (typeof safeStorageOperations)[keyof typeof safeStorageOperations]["input"]
>;

/** Bounds also applied to native buffers before allocation or copying. */
export const safeStorageLimits = {
  plaintextBytes: MAX_PLAINTEXT_BYTES,
  ciphertextBytes: MAX_CIPHERTEXT_BYTES,
  textCharacters: MAX_TEXT_CHARACTERS,
};
