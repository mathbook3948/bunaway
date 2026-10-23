import { BunawayError, type NativeEnvironment } from "@bunaway/plugin";
import {
  type SafeStorageInstance,
  safeStorageLimits,
} from "#safe-storage/contract";
import {
  transformMacosEnvelope,
  validateMacosEnvelope,
} from "#safe-storage/platforms/macos-envelope";
import {
  type MacosKeychainStore,
  protectionKey,
} from "#safe-storage/platforms/macos-key-store";
import { MacosKeychain } from "#safe-storage/platforms/macos-keychain";
/** Own one lazy Keychain provider and clear every per-call key and data buffer. */
export class MacosSafeStorage implements SafeStorageInstance {
  private store: MacosKeychainStore | undefined;
  private disposed = false;

  constructor(
    private readonly appId: string,
    private readonly open: () => MacosKeychainStore,
  ) {}

  private active(): void {
    if (this.disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Data protection adapter is disposed.",
      });
    }
  }

  private provider(): MacosKeychainStore {
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

  /** The Keychain stores the UTF-8 bytes; the input copy is zeroed once the Keychain has them. */
  setSecret(key: string, value: string): void {
    const bytes = Buffer.from(value, "utf8");
    try {
      this.provider().setSecret(key, bytes);
    } finally {
      bytes.fill(0);
    }
  }

  getSecret(key: string): string | null {
    const bytes = this.provider().getSecret(key);
    if (bytes === null) {
      return null;
    }
    try {
      return new TextDecoder("utf8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch {
      // The item was not written by this plugin, so its content has no defined meaning.
      throw new BunawayError({
        code: "INTERNAL",
        message: "Stored secret is not valid text.",
      });
    } finally {
      bytes.fill(0);
    }
  }

  deleteSecret(key: string): boolean {
    return this.provider().deleteSecret(key);
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

/**
 * Host-selected app.id is a stable Keychain namespace; OS access belongs to the actual executable.
 * The internal provider argument lets native fixtures use a disposable Keychain without changing
 * the public API, default Keychain, access settings or host-owned identity resolution.
 */
function provider(
  environment: NativeEnvironment,
  open: (appId: string) => MacosKeychainStore,
) {
  const appId = environment.app?.id;
  return {
    appId: appId ?? "",
    open: () => {
      if (
        !appId ||
        Buffer.byteLength(appId, "utf8") > 1024 ||
        appId.includes("\0")
      ) {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "macOS safe storage requires a stable host app identity.",
        });
      }
      return open(appId);
    },
  };
}

export function initialize(
  environment: NativeEnvironment,
  open: (appId: string) => MacosKeychainStore = (appId) =>
    new MacosKeychain(appId),
): MacosSafeStorage {
  const source = provider(environment, open);
  return new MacosSafeStorage(source.appId, source.open);
}

export function dispose(instance: MacosSafeStorage): void {
  instance.dispose();
}
