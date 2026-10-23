import { dlopen, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { BunawayError } from "@bunaway/plugin";
import { safeStorageLimits } from "#safe-storage/contract";
import { MACOS_KEY_BYTES } from "#safe-storage/platforms/macos-envelope";
import {
  keychainError,
  type MacosKeychainStore,
  secretAccount,
} from "#safe-storage/platforms/macos-key-store";

const SECURITY = "/System/Library/Frameworks/Security.framework/Security";
const CORE_FOUNDATION =
  "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const SERVICE = Buffer.from("org.bunaway.safe-storage.v1", "utf8");
// User secrets live under their own service so they never collide with the protection key item.
const SECRET_SERVICE = Buffer.from(
  "org.bunaway.safe-storage.secret.v1",
  "utf8",
);
// A stored secret is at most secretCharacters UTF-16 units; UTF-8 needs at most 3 bytes each.
const MAX_SECRET_BYTES = safeStorageLimits.secretCharacters * 3;
const ITEM_NOT_FOUND = -25300;
const DUPLICATE_ITEM = -25299;
const INTERACTION_NOT_ALLOWED = -25308;
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
      SecKeychainItemModifyAttributesAndData: {
        args: [
          "ptr",
          "ptr",
          "u32",
          "ptr",
        ],
        returns: "i32",
      },
      SecKeychainItemDelete: {
        args: [
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
export class MacosKeychain implements MacosKeychainStore {
  private readonly api = bindings();
  private readonly account: Buffer;
  private keychain: Pointer | undefined;
  private disposed = false;

  constructor(
    private readonly appId: string,
    fixtureKeychain?: Pointer,
  ) {
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

  /** Unlock the Keychain when needed. An explicit call permits Apple's unlock UI, never a supplied password. */
  private unlock(): void {
    const state = Buffer.alloc(4);
    const checked = this.api.security.symbols.SecKeychainGetStatus(
      this.reference(),
      ptr(state),
    );
    if (checked) {
      throw keychainError(checked);
    }
    if (state.readUInt32LE() & UNLOCKED) {
      return;
    }
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

  /**
   * Copy one generic password, or return null for a confirmed missing item. The native copy is
   * zeroed and freed exactly once, and a password longer than `maxBytes` is never copied.
   */
  private readPassword(
    service: Buffer,
    account: Buffer,
    maxBytes: number,
  ): Buffer | null {
    this.unlock();
    const length = Buffer.alloc(4);
    const content = Buffer.alloc(8);
    const status = this.api.security.symbols.SecKeychainFindGenericPassword(
      this.reference(),
      service.length,
      ptr(service),
      account.length,
      ptr(account),
      ptr(length),
      ptr(content),
      null,
    );
    // Password allocations come exclusively from Security.framework and are freed exactly once.
    const address = Number(content.readBigUInt64LE()) as Pointer;
    let password: Buffer | undefined;
    let freed = 0;
    try {
      if (status === ITEM_NOT_FOUND) {
        return null;
      }
      if (status) {
        throw keychainError(status);
      }
      const bytes = length.readUInt32LE();
      if (bytes > maxBytes || !address) {
        throw new BunawayError({
          code: "INTERNAL",
          message: "macOS Keychain item has an invalid size.",
        });
      }
      const native = new Uint8Array(toArrayBuffer(address, 0, bytes));
      try {
        password = Buffer.from(native);
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
    if (freed || !password) {
      password?.fill(0);
      throw keychainError(freed);
    }
    return password;
  }

  /** Return an item reference the caller must release with CFRelease, or null for a confirmed missing item. */
  private findItem(service: Buffer, account: Buffer): Pointer | null {
    this.unlock();
    const item = Buffer.alloc(8);
    const status = this.api.security.symbols.SecKeychainFindGenericPassword(
      this.reference(),
      service.length,
      ptr(service),
      account.length,
      ptr(account),
      null,
      null,
      ptr(item),
    );
    if (status === ITEM_NOT_FOUND) {
      return null;
    }
    if (status) {
      throw keychainError(status);
    }
    return Number(item.readBigUInt64LE()) as Pointer;
  }

  read(): Buffer | null {
    const key = this.readPassword(SERVICE, this.account, MACOS_KEY_BYTES);
    if (key && key.length !== MACOS_KEY_BYTES) {
      key.fill(0);
      throw new BunawayError({
        code: "INTERNAL",
        message: "macOS protection key has an invalid size.",
      });
    }
    return key;
  }

  add(key: Buffer): boolean {
    if (!this.available()) {
      // A failed lookup against a locked/unavailable Keychain must never cause key replacement.
      throw keychainError(INTERACTION_NOT_ALLOWED);
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

  /**
   * Store or replace one secret. Adding first keeps creation atomic; an existing item is modified
   * in place rather than deleted and re-added, so a failed update is not expected to lose the previous
   * value (not reproduced against a real Keychain). A delete between the two steps
   * makes the add run once more.
   */
  setSecret(key: string, value: Buffer): void {
    this.unlock();
    if (!this.available()) {
      throw keychainError(INTERACTION_NOT_ALLOWED);
    }
    const account = secretAccount(this.appId, key);
    for (let attempt = 0; attempt < 2; attempt++) {
      const added = this.api.security.symbols.SecKeychainAddGenericPassword(
        this.reference(),
        SECRET_SERVICE.length,
        ptr(SECRET_SERVICE),
        account.length,
        ptr(account),
        value.length,
        ptr(value),
        null,
      );
      if (added !== DUPLICATE_ITEM) {
        if (added) {
          throw keychainError(added);
        }
        return;
      }
      const item = this.findItem(SECRET_SERVICE, account);
      if (!item) {
        continue;
      }
      try {
        const modified =
          this.api.security.symbols.SecKeychainItemModifyAttributesAndData(
            item,
            null,
            value.length,
            ptr(value),
          );
        if (modified) {
          throw keychainError(modified);
        }
        return;
      } finally {
        this.api.core.symbols.CFRelease(item);
      }
    }
    throw keychainError(DUPLICATE_ITEM);
  }

  getSecret(key: string): Buffer | null {
    return this.readPassword(
      SECRET_SERVICE,
      secretAccount(this.appId, key),
      MAX_SECRET_BYTES,
    );
  }

  deleteSecret(key: string): boolean {
    const item = this.findItem(SECRET_SERVICE, secretAccount(this.appId, key));
    if (!item) {
      return false;
    }
    try {
      const status = this.api.security.symbols.SecKeychainItemDelete(item);
      if (status === ITEM_NOT_FOUND) {
        return false;
      }
      if (status) {
        throw keychainError(status);
      }
      return true;
    } finally {
      this.api.core.symbols.CFRelease(item);
    }
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
