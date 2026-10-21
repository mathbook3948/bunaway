import { dlopen, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { attemptAll, BunawayError } from "@bunaway/plugin";
import {
  ADVAPI32,
  KERNEL32,
  pick,
  wide,
  win32CallError,
} from "@bunaway/plugin/win32";
import { safeStorageLimits } from "#safe-storage/contract";

// Windows x64 CREDENTIALW is 80 bytes. Only the fields below are set or read.
const CREDENTIAL_BYTES = 80;
const TYPE_OFFSET = 4;
const TARGET_NAME_OFFSET = 8;
const BLOB_SIZE_OFFSET = 32;
const BLOB_POINTER_OFFSET = 40;
const PERSIST_OFFSET = 48;
const CRED_TYPE_GENERIC = 1;
// Stays on this machine: never roams with the profile and is not an enterprise credential.
const CRED_PERSIST_LOCAL_MACHINE = 2;
const TARGET_PREFIX = "bunaway.safe-storage";
const MAX_APP_ID_BYTES = 1024;

const ERROR_ACCESS_DENIED = 5;
const ERROR_BUSY = 170;
const ERROR_NOT_FOUND = 1168;
const ERROR_NO_SUCH_LOGON_SESSION = 1312;
const ERROR_SERVICE_NOT_ACTIVE = 1062;
const RPC_S_SERVER_UNAVAILABLE = 1722;
const RPC_S_SERVER_TOO_BUSY = 1723;
/** Errors where the same call can succeed later; every other error stays permanent. */
const TRANSIENT_CREDENTIAL_ERRORS: ReadonlySet<number> = new Set([
  ERROR_BUSY,
  ERROR_SERVICE_NOT_ACTIVE,
  ERROR_NO_SUCH_LOGON_SESSION,
  RPC_S_SERVER_UNAVAILABLE,
  RPC_S_SERVER_TOO_BUSY,
]);

/**
 * Credential Manager is per user, not per app. The plugin prefixes every target with the host
 * app id so one app cannot read or overwrite another app's entries or the user's own
 * credentials. Keys cannot contain ":", so the last colon always separates app id from key.
 */
export function credentialTargetName(appId: string, key: string): string {
  return `${TARGET_PREFIX}:${appId}:${key}`;
}

/** Reject an app id the host could not have supplied before it reaches a target name. */
export function assertCredentialAppId(appId: string | undefined): string {
  if (
    !appId ||
    appId.includes("\0") ||
    Buffer.byteLength(appId, "utf8") > MAX_APP_ID_BYTES
  ) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Credential storage requires a stable host app identity.",
    });
  }
  return appId;
}

/** Map a failed Credential Manager call to a stable error without echoing key or value. */
export function credentialFailure(code: number): BunawayError {
  if (TRANSIENT_CREDENTIAL_ERRORS.has(code)) {
    return new BunawayError({
      code: "BUSY",
      message: "Windows credential storage is temporarily unavailable.",
    });
  }
  if (code === ERROR_ACCESS_DENIED) {
    return new BunawayError({
      code: "PERMISSION_DENIED",
      message: "Windows denied access to credential storage.",
    });
  }
  return new BunawayError({
    code: "INTERNAL",
    message: "Windows credential storage failed.",
  });
}

function createBindings() {
  const kernel = dlopen("kernel32.dll", {
    ...pick(KERNEL32, "GetLastError"),
  });
  try {
    const advapi = dlopen("advapi32.dll", {
      ...pick(ADVAPI32, "CredWriteW", "CredReadW", "CredDeleteW", "CredFree"),
    });
    return {
      kernel,
      advapi,
    };
  } catch (error) {
    kernel.close();
    throw error;
  }
}

/**
 * Own Credential Manager bindings for one app. Secrets are stored as UTF-16LE generic
 * credentials. Every plaintext copy, including the native blob returned by `CredReadW`, is
 * zeroed before release, and `CredFree` is called exactly once per returned credential.
 * A started Win32 call cannot be interrupted, so cancellation only drops the late result.
 */
export class WindowsCredentialStore {
  private readonly api = createBindings();
  private disposed = false;

  constructor(private readonly appId: string) {}

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    attemptAll(
      [
        () => this.api.advapi.close(),
        () => this.api.kernel.close(),
      ],
      "Credential storage bindings did not close cleanly.",
    );
  }

  private active(): void {
    if (this.disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Credential storage adapter is disposed.",
      });
    }
  }

  private readonly lastError = () => this.api.kernel.symbols.GetLastError();

  set(key: string, value: string): void {
    this.active();
    const target = wide(credentialTargetName(this.appId, key));
    const blob = Buffer.from(value, "utf16le");
    const credential = Buffer.alloc(CREDENTIAL_BYTES);
    try {
      if (blob.length > safeStorageLimits.secretBlobBytes) {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Secret is too large.",
        });
      }
      credential.writeUInt32LE(CRED_TYPE_GENERIC, TYPE_OFFSET);
      credential.writeBigUInt64LE(BigInt(ptr(target)), TARGET_NAME_OFFSET);
      credential.writeUInt32LE(blob.length, BLOB_SIZE_OFFSET);
      credential.writeBigUInt64LE(BigInt(ptr(blob)), BLOB_POINTER_OFFSET);
      credential.writeUInt32LE(CRED_PERSIST_LOCAL_MACHINE, PERSIST_OFFSET);
      // CredWriteW replaces the same target, so repeating it after a lost error is safe.
      const failure = win32CallError(
        () => this.api.advapi.symbols.CredWriteW(ptr(credential), 0),
        this.lastError,
      );
      if (failure) {
        throw credentialFailure(failure);
      }
    } finally {
      blob.fill(0);
    }
  }

  get(key: string): string | null {
    this.active();
    const target = wide(credentialTargetName(this.appId, key));
    const out = Buffer.alloc(8);
    const failure = win32CallError(
      () =>
        this.api.advapi.symbols.CredReadW(
          ptr(target),
          CRED_TYPE_GENERIC,
          0,
          ptr(out),
        ),
      this.lastError,
    );
    if (failure === ERROR_NOT_FOUND) {
      return null;
    }
    if (failure) {
      throw credentialFailure(failure);
    }
    const address = Number(out.readBigUInt64LE(0)) as Pointer;
    if (!address) {
      throw credentialFailure(0);
    }
    let copy: Buffer | undefined;
    let native: Uint8Array | undefined;
    try {
      const header = Buffer.from(toArrayBuffer(address, 0, CREDENTIAL_BYTES));
      const size = header.readUInt32LE(BLOB_SIZE_OFFSET);
      const blobAddress = Number(
        header.readBigUInt64LE(BLOB_POINTER_OFFSET),
      ) as Pointer;
      if (
        !blobAddress ||
        size === 0 ||
        size % 2 !== 0 ||
        size > safeStorageLimits.secretBlobBytes
      ) {
        throw credentialFailure(0);
      }
      native = new Uint8Array(toArrayBuffer(blobAddress, 0, size));
      copy = Buffer.from(native);
      return copy.toString("utf16le");
    } finally {
      native?.fill(0);
      copy?.fill(0);
      this.api.advapi.symbols.CredFree(address);
    }
  }

  delete(key: string): boolean {
    this.active();
    const target = wide(credentialTargetName(this.appId, key));
    const failure = win32CallError(
      () =>
        this.api.advapi.symbols.CredDeleteW(ptr(target), CRED_TYPE_GENERIC, 0),
      this.lastError,
    );
    if (failure === ERROR_NOT_FOUND) {
      return false;
    }
    if (failure) {
      throw credentialFailure(failure);
    }
    return true;
  }
}
