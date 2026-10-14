import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { BunawayError } from "@bunaway/plugin";
import { safeStorageLimits } from "#safe-storage/contract";
export const MACOS_KEY_BYTES = 32;
const MAGIC = Buffer.from("BWSK");
const VERSION = 1;
const HEADER_BYTES = 5;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const OVERHEAD_BYTES = HEADER_BYTES + NONCE_BYTES + TAG_BYTES;

function invalidEnvelope(): BunawayError {
  return new BunawayError({
    code: "INTERNAL",
    message: "macOS could not authenticate the protected data.",
  });
}

/** Validate the version and bounds before asking Keychain to unlock or authorize access. */
export function validateMacosEnvelope(input: Buffer): void {
  if (
    input.length < OVERHEAD_BYTES ||
    input.length > safeStorageLimits.plaintextBytes + OVERHEAD_BYTES ||
    !input.subarray(0, MAGIC.length).equals(MAGIC) ||
    input[MAGIC.length] !== VERSION
  ) {
    throw invalidEnvelope();
  }
}

/**
 * AES-256-GCM through Bun's vetted node:crypto implementation. The version header
 * and stable app namespace are authenticated; ciphertext is never treated as plaintext.
 * The caller owns and wipes the returned bytes and the per-operation Keychain key.
 */
export function transformMacosEnvelope(
  input: Buffer,
  key: Buffer,
  appId: string,
  decrypt: boolean,
): Buffer {
  if (key.length !== MACOS_KEY_BYTES) {
    throw new BunawayError({
      code: "INTERNAL",
      message: "macOS protection key has an invalid size.",
    });
  }
  if (decrypt) {
    validateMacosEnvelope(input);
  } else if (input.length > safeStorageLimits.plaintextBytes) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Data protection input is too large.",
    });
  }
  const header = decrypt
    ? input.subarray(0, HEADER_BYTES)
    : Buffer.concat([
        MAGIC,
        Buffer.from([
          VERSION,
        ]),
      ]);
  const aad = Buffer.concat([
    header,
    Buffer.from(appId, "utf8"),
  ]);
  const nonce = decrypt
    ? input.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES)
    : randomBytes(NONCE_BYTES);
  let partial: Buffer | undefined;
  let final: Buffer | undefined;
  try {
    if (decrypt) {
      const cipher = createDecipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad);
      cipher.setAuthTag(input.subarray(input.length - TAG_BYTES));
      partial = cipher.update(
        input.subarray(HEADER_BYTES + NONCE_BYTES, input.length - TAG_BYTES),
      );
      // update may produce unauthenticated bytes. Never return them until final verifies the tag.
      final = cipher.final();
      return Buffer.concat([
        partial,
        final,
      ]);
    }
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad);
    partial = cipher.update(input);
    final = cipher.final();
    return Buffer.concat([
      header,
      nonce,
      partial,
      final,
      cipher.getAuthTag(),
    ]);
  } catch {
    throw invalidEnvelope();
  } finally {
    partial?.fill(0);
    final?.fill(0);
  }
}
