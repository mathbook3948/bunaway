import { dlopen, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { BunawayError } from "@bunaway/plugin";
import { MACOS_KEY_BYTES } from "./macos-envelope.ts";
import { keychainError, type MacosKeyStore } from "./macos-key-store.ts";

const SECURITY = "/System/Library/Frameworks/Security.framework/Security";
const CORE_FOUNDATION =
  "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const SERVICE = Buffer.from("org.bunaway.safe-storage.v1", "utf8");
const ITEM_NOT_FOUND = -25300;
const DUPLICATE_ITEM = -25299;
const UNLOCKED = 1;
const READABLE = 2;
const WRITABLE = 4;

function bindings() {
  const core = dlopen(CORE_FOUNDATION, {
    CFRetain: {
      args: [
        "ptr",
      ],
      returns: "ptr",
    },
    CFRelease: {
      args: [
        "ptr",
      ],
      returns: "void",
    },
  });
  try {
    const security = dlopen(SECURITY, {
      SecKeychainCopyDefault: {
        args: [
          "ptr",
        ],
        returns: "i32",
      },
      SecKeychainGetStatus: {
        args: [
          "ptr",
          "ptr",
        ],
        returns: "i32",
      },
      SecKeychainUnlock: {
        args: [
          "ptr",
          "u32",
          "ptr",
          "bool",
        ],
        returns: "i32",
      },
      SecKeychainFindGenericPassword: {
        args: [
          "ptr",
          "u32",
          "ptr",
          "u32",
          "ptr",
          "ptr",
          "ptr",
          "ptr",
        ],
        returns: "i32",
      },
      SecKeychainAddGenericPassword: {
        args: [
          "ptr",
          "u32",
          "ptr",
          "u32",
          "ptr",
          "u32",
          "ptr",
          "ptr",
        ],
        returns: "i32",
      },
      SecKeychainItemFreeContent: {
        args: [
          "ptr",
          "ptr",
        ],
        returns: "i32",
      },
    });
    return {
      core,
      security,
    };
  } catch (error) {
    core.close();
    throw error;
  }
}

/**
 * Traditional file-based Keychain, with the default ACL tied to the executable
 * creating the item. appId selects an account namespace, never an OS principal.
 * Explicit calls may show Apple's access/unlock dialogs. No process-wide UI flag,
 * access list, entitlement, trust setting or Keychain search list is changed.
 * A retained explicit Keychain reference is accepted only by internal native fixtures.
 */
export class MacosKeychain implements MacosKeyStore {
  private readonly api = bindings();
  private readonly account: Buffer;
  private keychain: Pointer | undefined;
  private disposed = false;

  constructor(appId: string, fixtureKeychain?: Pointer) {
    this.account = Buffer.from(appId, "utf8");
    if (fixtureKeychain) {
      // CF Keychain references are untagged pointers, unlike Objective-C tagged objects.
      this.keychain = Number(
        this.api.core.symbols.CFRetain(fixtureKeychain),
      ) as Pointer;
    }
  }

  private reference(): Pointer {
    if (this.disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Keychain adapter is disposed.",
      });
    }
    if (!this.keychain) {
      const result = Buffer.alloc(8);
      const status = this.api.security.symbols.SecKeychainCopyDefault(
        ptr(result),
      );
      // Security.framework alone writes these 64-bit CF object references.
      this.keychain = Number(result.readBigUInt64LE()) as Pointer;
      if (status || !this.keychain) {
        if (this.keychain) {
          this.api.core.symbols.CFRelease(this.keychain);
          this.keychain = undefined;
        }
        throw keychainError(status);
      }
    }
    return this.keychain;
  }

  available(): boolean {
    const status = Buffer.alloc(4);
    const result = this.api.security.symbols.SecKeychainGetStatus(
      this.reference(),
      ptr(status),
    );
    if (result) {
      throw keychainError(result);
    }
    const required = UNLOCKED | READABLE | WRITABLE;
    return (status.readUInt32LE() & required) === required;
  }

  read(): Buffer | null {
    const state = Buffer.alloc(4);
    const checked = this.api.security.symbols.SecKeychainGetStatus(
      this.reference(),
      ptr(state),
    );
    if (checked) {
      throw keychainError(checked);
    }
    if (!(state.readUInt32LE() & UNLOCKED)) {
      // An explicit encryption/decryption call permits Apple's unlock UI, never a supplied password.
      const unlocked = this.api.security.symbols.SecKeychainUnlock(
        this.reference(),
        0,
        null,
        false,
      );
      if (unlocked) {
        throw keychainError(unlocked);
      }
    }
    const length = Buffer.alloc(4);
    const content = Buffer.alloc(8);
    const status = this.api.security.symbols.SecKeychainFindGenericPassword(
      this.reference(),
      SERVICE.length,
      ptr(SERVICE),
      this.account.length,
      ptr(this.account),
      ptr(length),
      ptr(content),
      null,
    );
    // Password allocations come exclusively from Security.framework and are freed exactly once.
    const address = Number(content.readBigUInt64LE()) as Pointer;
    let key: Buffer | undefined;
    let freed = 0;
    try {
      if (status === ITEM_NOT_FOUND) {
        return null;
      }
      if (status) {
        throw keychainError(status);
      }
      if (length.readUInt32LE() !== MACOS_KEY_BYTES || !address) {
        throw new BunawayError({
          code: "INTERNAL",
          message: "macOS protection key has an invalid size.",
        });
      }
      const native = new Uint8Array(toArrayBuffer(address, 0, MACOS_KEY_BYTES));
      try {
        key = Buffer.from(native);
      } finally {
        native.fill(0);
      }
    } finally {
      if (address) {
        freed = this.api.security.symbols.SecKeychainItemFreeContent(
          null,
          address,
        );
      }
    }
    if (freed || !key) {
      key?.fill(0);
      throw keychainError(freed);
    }
    return key;
  }

  add(key: Buffer): boolean {
    if (!this.available()) {
      // A failed lookup against a locked/unavailable Keychain must never cause key replacement.
      throw keychainError(-25308);
    }
    const status = this.api.security.symbols.SecKeychainAddGenericPassword(
      this.reference(),
      SERVICE.length,
      ptr(SERVICE),
      this.account.length,
      ptr(this.account),
      key.length,
      ptr(key),
      null,
    );
    if (status === DUPLICATE_ITEM) {
      return false;
    }
    if (status) {
      throw keychainError(status);
    }
    return true;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.keychain) {
      this.api.core.symbols.CFRelease(this.keychain);
      this.keychain = undefined;
    }
    this.api.security.close();
    this.api.core.close();
  }
}
