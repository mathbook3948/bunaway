import { dlopen, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { KERNEL32, pick } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/plugin";
import { safeStorageLimits } from "#safe-storage/contract";

// Windows x64 DATA_BLOB: DWORD length, four bytes of padding, then an eight-byte pointer.
const DATA_BLOB_BYTES = 16;
const DATA_BLOB_POINTER_OFFSET = 8;
const CRYPTPROTECT_UI_FORBIDDEN = 0x1;

function createBindings() {
  const kernel = dlopen("kernel32.dll", {
    ...pick(KERNEL32, "LocalFree"),
  });
  try {
    const crypt = dlopen("crypt32.dll", {
      CryptProtectData: {
        args: [
          "ptr",
          "ptr",
          "ptr",
          "ptr",
          "ptr",
          "u32",
          "ptr",
        ],
        returns: "i32",
      },
      CryptUnprotectData: {
        args: [
          "ptr",
          "ptr",
          "ptr",
          "ptr",
          "ptr",
          "u32",
          "ptr",
        ],
        returns: "i32",
      },
    });
    return {
      kernel,
      crypt,
    };
  } catch (error) {
    kernel.close();
    throw error;
  }
}

/** Own current-user DPAPI bindings. Input and output copies are wiped before release. */
export class WindowsDataProtection {
  private readonly api = createBindings();
  private disposed = false;

  /** Bindings are independent across adapters and may be released repeatedly. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.api.crypt.close();
    this.api.kernel.close();
  }

  /** Encrypt or decrypt one bounded byte buffer. Does not persist data or use app credentials. */
  transform(input: Buffer, decrypt: boolean): Buffer {
    if (this.disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Data protection adapter is disposed.",
      });
    }
    const inputLimit = decrypt
      ? safeStorageLimits.ciphertextBytes
      : safeStorageLimits.plaintextBytes;
    const outputLimit = decrypt
      ? safeStorageLimits.plaintextBytes
      : safeStorageLimits.ciphertextBytes;
    if (input.length > inputLimit) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Data protection input is too large.",
      });
    }
    // DPAPI receives a non-null buffer even for zero-length plaintext. The caller keeps its own copy.
    const bytes = Buffer.alloc(Math.max(1, input.length));
    input.copy(bytes);
    const source = Buffer.alloc(DATA_BLOB_BYTES);
    source.writeUInt32LE(input.length, 0);
    source.writeBigUInt64LE(BigInt(ptr(bytes)), DATA_BLOB_POINTER_OFFSET);
    const destination = Buffer.alloc(DATA_BLOB_BYTES);
    let output: Buffer | undefined;
    try {
      const invoke = decrypt
        ? this.api.crypt.symbols.CryptUnprotectData
        : this.api.crypt.symbols.CryptProtectData;
      const succeeded = invoke(
        ptr(source),
        null,
        null,
        null,
        null,
        CRYPTPROTECT_UI_FORBIDDEN,
        ptr(destination),
      );
      if (!succeeded) {
        throw new BunawayError({
          code: "INTERNAL",
          message: decrypt
            ? "Windows could not decrypt the protected data."
            : "Windows could not protect the data.",
        });
      }
      const size = destination.readUInt32LE(0);
      // Only DPAPI writes this pointer. A native allocation must fit the public output bound.
      const address = Number(
        destination.readBigUInt64LE(DATA_BLOB_POINTER_OFFSET),
      ) as Pointer;
      if (size > 0 && address) {
        output = Buffer.from(toArrayBuffer(address, 0, size));
      }
      if (size > outputLimit || (size > 0 && !address)) {
        throw new BunawayError({
          code: "INTERNAL",
          message: "Data protection output exceeds its contract.",
        });
      }
      if (!size) {
        return Buffer.alloc(0);
      }
      return output ? Buffer.from(output) : Buffer.alloc(0);
    } finally {
      bytes.fill(0);
      output?.fill(0);
      const address = Number(
        destination.readBigUInt64LE(DATA_BLOB_POINTER_OFFSET),
      ) as Pointer;
      if (address) {
        // DPAPI supplies a valid LocalAlloc pointer. This instance releases it exactly once.
        this.api.kernel.symbols.LocalFree(address);
      }
    }
  }
}
