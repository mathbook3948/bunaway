import { randomBytes } from "node:crypto";
import { BunawayError } from "@bunaway/plugin";
import { MACOS_KEY_BYTES } from "#safe-storage/platforms/macos-envelope";
/** File-based Keychain operations for the protection key. No update or delete operation is exposed. */
export interface MacosKeyStore {
  /** Read-only, non-prompting Keychain status. Does not read or create secret data. */
  available(): boolean;
  /** Return an owned key copy, or null only for a confirmed missing item. May show system UI. */
  read(): Buffer | null;
  /** Add only if absent. False means another process won the creation race. */
  add(key: Buffer): boolean;
  dispose(): void;
}

/**
 * App-scoped user secrets as Keychain generic passwords. Values are UTF-8 bytes the caller owns
 * and zeroes. A missing item reads as null and deletes as false.
 */
export interface MacosSecretStore {
  /** Create or replace the secret; may show system UI to unlock the Keychain. */
  setSecret(key: string, value: Buffer): void;
  getSecret(key: string): Buffer | null;
  deleteSecret(key: string): boolean;
}

/** Everything the macOS adapter needs from one Keychain. */
export type MacosKeychainStore = MacosKeyStore & MacosSecretStore;

/**
 * Keychain account of one secret. The host app id selects the namespace and keys exclude ":", so
 * the last colon separates the two and no app can address another app's entry.
 */
export function secretAccount(appId: string, key: string): Buffer {
  return Buffer.from(`${appId}:${key}`, "utf8");
}

/** Resolve each operation afresh; denied, locked or malformed keys are never replaced or cached. */
export function protectionKey(store: MacosKeyStore, create: boolean): Buffer {
  let key = store.read();
  if (key === null && create) {
    const candidate = randomBytes(MACOS_KEY_BYTES);
    try {
      // Re-read even after successful insertion to prove this executable can access the stored key.
      store.add(candidate);
      key = store.read();
    } finally {
      candidate.fill(0);
    }
  }
  if (key === null) {
    throw new BunawayError({
      code: "INTERNAL",
      message:
        "macOS protection key is missing. Existing data cannot be decrypted.",
    });
  }
  if (key.length !== MACOS_KEY_BYTES) {
    key.fill(0);
    throw new BunawayError({
      code: "INTERNAL",
      message: "macOS protection key has an invalid size.",
    });
  }
  return key;
}

/** Convert OS failures without exposing protected data or replacing an inaccessible item. */
export function keychainError(status: number): BunawayError {
  if (status === -128) {
    return new BunawayError({
      code: "CANCELLED",
      message: "Keychain access was cancelled by the user.",
    });
  }
  if (status === -25293 || status === -25308 || status === -25315) {
    return new BunawayError({
      code: "PERMISSION_DENIED",
      message:
        "Keychain access was denied or requires unavailable system interaction.",
    });
  }
  return new BunawayError({
    code: "INTERNAL",
    message: "macOS Keychain is unavailable or could not complete the request.",
  });
}
