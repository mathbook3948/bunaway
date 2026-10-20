import { dlopen, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { BunawayError } from "@bunaway/plugin";
import { KERNEL32, pick, win32CallError } from "@bunaway/plugin/win32";
import { safeStorageLimits } from "#safe-storage/contract";

// Windows x64 DATA_BLOB: DWORD length, four bytes of padding, then an eight-byte pointer.
const DATA_BLOB_BYTES = 16;
const DATA_BLOB_POINTER_OFFSET = 8;
const CRYPTPROTECT_UI_FORBIDDEN = 0x1;

/**
 * Win32 errors that mean the key service is not ready or did not answer, so the same call can
 * succeed later: ERROR_BUSY, ERROR_SERVICE_NOT_ACTIVE, RPC_S_SERVER_UNAVAILABLE and
 * RPC_S_SERVER_TOO_BUSY. Every other error, including ERROR_INVALID_DATA for a damaged blob and
 * an unreadable error, stays a permanent failure so data is never reported as retryable by guess.
 */
const TRANSIENT_DPAPI_ERRORS: ReadonlySet<number> = new Set([
  170,
  1062,
  1722,
  1723,
]);

/** Map the Win32 error of a failed DPAPI call to `BUSY` (retry later) or `INTERNAL` (permanent). */
export function dpapiFailure(code: number, decrypt: boolean): BunawayError {
  if (TRANSIENT_DPAPI_ERRORS.has(code)) {
    return new BunawayError({
      code: "BUSY",
      message: "Windows data protection is temporarily unavailable.",
    });
  }
  return new BunawayError({
    code: "INTERNAL",
    message: decrypt
      ? "Windows could not decrypt the protected data."
      : "Windows could not protect the data.",
  });
}

function createBindings() {
  const kernel = dlopen("kernel32.dll", {
    ...pick(KERNEL32, "LocalFree", "GetLastError"),
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
      // Both calls read the input blob and leave it unchanged, so a repeat is safe when the first
      // last-error read is overwritten by the FFI layer.
      const failure = win32CallError(
        () =>
          invoke(
            ptr(source),
            null,
            null,
            null,
            null,
            CRYPTPROTECT_UI_FORBIDDEN,
            ptr(destination),
          ),
        () => this.api.kernel.symbols.GetLastError(),
      );
      if (failure) {
        throw dpapiFailure(failure, decrypt);
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
