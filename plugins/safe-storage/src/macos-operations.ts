import { BunawayError } from "@bunaway/plugin";
import { safeStorageLimits } from "./contract.ts";
import {
  transformMacosEnvelope,
  validateMacosEnvelope,
} from "./macos-envelope.ts";
import { type MacosKeyStore, protectionKey } from "./macos-key-store.ts";

/** Own one lazy Keychain provider and clear every per-call key and data buffer. */
export class MacosSafeStorage {
  private store: MacosKeyStore | undefined;
  private disposed = false;

  constructor(
    private readonly appId: string,
    private readonly open: () => MacosKeyStore,
  ) {}

  private active(): void {
    if (this.disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Data protection adapter is disposed.",
      });
    }
  }

  private provider(): MacosKeyStore {
    this.active();
    this.store ??= this.open();
    return this.store;
  }

  isAvailable(): boolean {
    this.active();
    try {
      return this.provider().available();
    } catch {
      return false;
    }
  }

  private transform(
    bytes: Buffer,
    decrypt: boolean,
    stringResult: boolean,
  ): string {
    let key: Buffer | undefined;
    let result: Buffer | undefined;
    try {
      if (decrypt) {
        validateMacosEnvelope(bytes);
      }
      key = protectionKey(this.provider(), !decrypt);
      result = transformMacosEnvelope(bytes, key, this.appId, decrypt);
      if (!stringResult) {
        return result.toString("base64");
      }
      const text = new TextDecoder("utf8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(result);
      if (text.length > safeStorageLimits.textCharacters) {
        throw new BunawayError({
          code: "INTERNAL",
          message: "Decrypted text exceeds its contract.",
        });
      }
      return text;
    } finally {
      bytes.fill(0);
      key?.fill(0);
      result?.fill(0);
    }
  }

  encryptString(text: string): string {
    return this.transform(Buffer.from(text, "utf8"), false, false);
  }

  decryptString(ciphertext: string): string {
    return this.transform(Buffer.from(ciphertext, "base64"), true, true);
  }

  encryptBytes(bytes: string): string {
    return this.transform(Buffer.from(bytes, "base64"), false, false);
  }

  decryptBytes(ciphertext: string): string {
    return this.transform(Buffer.from(ciphertext, "base64"), true, false);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.store?.dispose();
    this.store = undefined;
  }
}
