import { base64Schema } from "@bunaway/plugin";
import { z } from "zod";

const MAX_PLAINTEXT_BYTES = 256 * 1024;
const MAX_CIPHERTEXT_BYTES = 384 * 1024;
const MAX_TEXT_CHARACTERS = 32 * 1024;
// CRED_MAX_CREDENTIAL_BLOB_SIZE is 5 * 512 bytes; secrets are stored as UTF-16LE, two bytes per unit.
const MAX_CREDENTIAL_BLOB_BYTES = 5 * 512;
const MAX_SECRET_CHARACTERS = MAX_CREDENTIAL_BLOB_BYTES / 2;
const MAX_SECRET_KEY_CHARACTERS = 128;

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

// A lone surrogate has no UTF-16LE round trip through other Credential Manager readers.
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * Secret keys are lowercase ASCII because Credential Manager compares target names without
 * regard to case, so "Token" and "token" would be one entry. They exclude ":" so the
 * plugin-owned target name `prefix:appId:key` has exactly one reading; the key is the part
 * after the last colon.
 */
export const secretKeySchema = z
  .string()
  .min(1)
  .max(MAX_SECRET_KEY_CHARACTERS)
  .regex(/^[a-z0-9._-]+$/);
export const secretValueSchema = z
  .string()
  .min(1)
  .max(MAX_SECRET_CHARACTERS)
  .refine(
    (value) => !LONE_SURROGATE.test(value),
    "Secret must be well-formed UTF-16.",
  );
export const secretKeyInputSchema = z.strictObject({
  key: secretKeySchema,
});
export const setSecretInputSchema = z.strictObject({
  key: secretKeySchema,
  value: secretValueSchema,
});

/** Common instance shape chosen by this plugin because both platforms expose the same operations. */
export interface SafeStorageInstance {
  isAvailable(): boolean;
  encryptString(text: string): string;
  decryptString(ciphertext: string): string;
  encryptBytes(bytes: string): string;
  decryptBytes(ciphertext: string): string;
}

/** Windows adds an app-scoped Credential Manager store on top of the shared operations. */
export interface WindowsSafeStorageInstance extends SafeStorageInstance {
  setSecret(key: string, value: string): void;
  getSecret(key: string): string | null;
  deleteSecret(key: string): boolean;
}

/** Bounds also applied to native buffers before allocation or copying. */
export const safeStorageLimits = {
  plaintextBytes: MAX_PLAINTEXT_BYTES,
  ciphertextBytes: MAX_CIPHERTEXT_BYTES,
  textCharacters: MAX_TEXT_CHARACTERS,
  secretBlobBytes: MAX_CREDENTIAL_BLOB_BYTES,
  secretCharacters: MAX_SECRET_CHARACTERS,
  secretKeyCharacters: MAX_SECRET_KEY_CHARACTERS,
};
