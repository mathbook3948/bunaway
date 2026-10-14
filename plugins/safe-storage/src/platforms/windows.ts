import { BunawayError } from "@bunaway/plugin";
import { safeStorageLimits } from "#safe-storage/contract";
import { WindowsDataProtection } from "#safe-storage/platforms/windows-dpapi";
/** Lazily bind DPAPI so an unavailable provider can still be queried safely. */
export class WindowsSafeStorage {
  private native: WindowsDataProtection | undefined;
  private disposed = false;

  private active(): void {
    if (this.disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Data protection adapter is disposed.",
      });
    }
  }

  private provider(): WindowsDataProtection {
    this.active();
    this.native ??= new WindowsDataProtection();
    return this.native;
  }

  isAvailable(): boolean {
    this.active();
    let protectedData: Buffer | undefined;
    let restored: Buffer | undefined;
    try {
      const probe = Buffer.from("bunaway-dpapi-probe");
      protectedData = this.provider().transform(probe, false);
      restored = this.provider().transform(protectedData, true);
      return restored.equals(probe);
    } catch {
      // A capability probe is never a promise that later operations will succeed.
      return false;
    } finally {
      protectedData?.fill(0);
      restored?.fill(0);
    }
  }

  /** Clear both input and output buffers even when native protection fails. */
  private transform(
    bytes: Buffer,
    decrypt: boolean,
    stringResult: boolean,
  ): string {
    let result: Buffer | undefined;
    try {
      result = this.provider().transform(bytes, decrypt);
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
    this.native?.dispose();
    this.native = undefined;
  }
}

export function initialize(): WindowsSafeStorage {
  return new WindowsSafeStorage();
}

export function dispose(instance: WindowsSafeStorage): void {
  instance.dispose();
}
