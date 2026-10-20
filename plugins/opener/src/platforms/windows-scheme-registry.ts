import { dlopen, ptr } from "bun:ffi";
import { attemptAll, failWithCleanup, ResourceOwner } from "@bunaway/plugin";
import {
  ADVAPI32,
  KERNEL32,
  pick,
  SHELL32,
  wide,
  withWide,
} from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";
import type { SchemeStore } from "#opener/platforms/windows-url-scheme";

const HKEY_CLASSES_ROOT = 0xffffffff80000000n;
const HKEY_CURRENT_USER = 0xffffffff80000001n;
const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
const ERROR_MORE_DATA = 234;
const REG_SZ = 1;
const RRF_RT_REG_SZ = 0x2;
const RRF_SUBKEY_WOW6464KEY = 0x10000;
const KEY_QUERY_VALUE = 0x1;
const KEY_SET_VALUE = 0x2;
const KEY_WOW64_64KEY = 0x100;
const SHCNE_ASSOCCHANGED = 0x08000000;
const SHCNF_IDLIST = 0;
const SYNCHRONIZE_AND_MUTEX_MODIFY = 0x00100000 | 0x1;
const WAIT_ABANDONED = 128;
const WAIT_ACQUIRED = 0;
const WAIT_TIMEOUT = 258;
/** Largest string value read back, in bytes; a bigger value is not one this plugin wrote. */
const MAX_VALUE_BYTES = 8192;

function registryError(code: number): BunawayError {
  return new BunawayError({
    code: code === ERROR_ACCESS_DENIED ? "PERMISSION_DENIED" : "INTERNAL",
    message: `Windows registry operation failed (Win32 ${code}).`,
  });
}

function check(code: number): void {
  if (code !== ERROR_SUCCESS) {
    throw registryError(code);
  }
}

/** Convert an empty name to the null pointer that addresses a key's default value. */
const valueName = (name: string) => (name === "" ? null : wide(name));

/**
 * Open advapi32, kernel32 and shell32 for the life of the opener and give the user-hive
 * access the URL scheme registration needs. Values use the native 64-bit registry view.
 * Every key handle is closed in the call that opened it, so only the libraries need an owner.
 */
export function createSchemeStore(): SchemeStore & {
  dispose(): void;
} {
  const owner = new ResourceOwner("URL scheme registry cleanup failed.");
  const advapi = owner.acquire(
    () =>
      dlopen("advapi32.dll", {
        ...pick(
          ADVAPI32,
          "RegGetValueW",
          "RegCreateKeyExW",
          "RegOpenKeyExW",
          "RegSetValueExW",
          "RegDeleteTreeW",
          "RegCloseKey",
        ),
      }),
    (library) => library.close(),
  );
  const kernel = owner.acquire(
    () =>
      dlopen("kernel32.dll", {
        ...pick(
          KERNEL32,
          "CreateMutexExW",
          "WaitForSingleObject",
          "ReleaseMutex",
          "CloseHandle",
          "GetLastError",
        ),
      }),
    (library) => library.close(),
  );
  const shell = owner.acquire(
    () =>
      dlopen("shell32.dll", {
        ...pick(SHELL32, "SHChangeNotify"),
      }),
    (library) => library.close(),
  );
  function active(): void {
    if (owner.disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Opener has been disposed.",
      });
    }
  }

  /** Probe a key under a predefined root, closing the handle it opens. */
  function keyExistsUnder(root: bigint, path: string): boolean {
    const handle = new BigUint64Array(1);
    const result = withWide(path, (address) =>
      advapi.symbols.RegOpenKeyExW(
        root,
        address,
        0,
        KEY_QUERY_VALUE | KEY_WOW64_64KEY,
        ptr(handle),
      ),
    );
    if (result === ERROR_FILE_NOT_FOUND || result === ERROR_PATH_NOT_FOUND) {
      return false;
    }
    check(result);
    check(advapi.symbols.RegCloseKey(handle[0] ?? 0n));
    return true;
  }

  return {
    withLock<T>(scheme: string, work: () => T): T {
      active();
      // The classes hive is shared by the user's sessions, but a Local mutex avoids the user
      // SID a Global name needs to stay clear of other users; concurrent registration from
      // two sessions of one user is not coordinated.
      const name = wide(`Local\\Bunaway.UrlScheme.${scheme}`);
      const handle = kernel.symbols.CreateMutexExW(
        null,
        ptr(name),
        0,
        SYNCHRONIZE_AND_MUTEX_MODIFY,
      );
      if (!handle) {
        throw registryError(kernel.symbols.GetLastError());
      }
      let owned = false;
      try {
        // Contention returns immediately so the I/O worker stays responsive to cancellation.
        const waited = kernel.symbols.WaitForSingleObject(handle, 0);
        if (waited === WAIT_TIMEOUT) {
          throw new BunawayError({
            code: "BUSY",
            message: "Another process is changing this URL scheme.",
          });
        }
        owned = waited === WAIT_ACQUIRED || waited === WAIT_ABANDONED;
        if (!owned) {
          throw registryError(kernel.symbols.GetLastError());
        }
        return work();
      } finally {
        // Release and close both run; a failure of either is reported with the other.
        attemptAll(
          [
            () => {
              if (owned && !kernel.symbols.ReleaseMutex(handle)) {
                throw registryError(kernel.symbols.GetLastError());
              }
            },
            () => {
              if (!kernel.symbols.CloseHandle(handle)) {
                throw registryError(kernel.symbols.GetLastError());
              }
            },
          ],
          "URL scheme mutex cleanup failed.",
        );
      }
    },

    keyExists(path: string): boolean {
      active();
      return keyExistsUnder(HKEY_CURRENT_USER, path);
    },

    classExists(name: string): boolean {
      active();
      return keyExistsUnder(HKEY_CLASSES_ROOT, name);
    },

    readString(path: string, name: string): string | null {
      active();
      const subkey = wide(path);
      const value = valueName(name);
      const data = Buffer.alloc(MAX_VALUE_BYTES);
      const size = new Uint32Array([
        data.length,
      ]);
      const result = advapi.symbols.RegGetValueW(
        HKEY_CURRENT_USER,
        ptr(subkey),
        value === null ? null : ptr(value),
        RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
        null,
        ptr(data),
        ptr(size),
      );
      if (result === ERROR_FILE_NOT_FOUND || result === ERROR_PATH_NOT_FOUND) {
        return null;
      }
      // A value too large to read cannot equal anything this plugin writes.
      if (result === ERROR_MORE_DATA) {
        return "\u0000";
      }
      check(result);
      // The size includes the terminating NUL.
      return data
        .subarray(0, Math.max((size[0] ?? 0) - 2, 0))
        .toString("utf16le");
    },

    writeString(path: string, name: string, value: string): void {
      active();
      const subkey = wide(path);
      const data = wide(value);
      const label = valueName(name);
      const handle = new BigUint64Array(1);
      check(
        advapi.symbols.RegCreateKeyExW(
          HKEY_CURRENT_USER,
          ptr(subkey),
          0,
          null,
          0,
          KEY_SET_VALUE | KEY_WOW64_64KEY,
          null,
          ptr(handle),
          null,
        ),
      );
      const closeKey = () => check(advapi.symbols.RegCloseKey(handle[0] ?? 0n));
      try {
        check(
          advapi.symbols.RegSetValueExW(
            handle[0] ?? 0n,
            label === null ? null : ptr(label),
            0,
            REG_SZ,
            ptr(data),
            data.length,
          ),
        );
      } catch (error) {
        // Keep the write failure when closing the key fails as well.
        failWithCleanup(
          error,
          closeKey,
          "Registry write and key close failed.",
        );
      }
      closeKey();
    },

    deleteTree(path: string): void {
      active();
      const result = withWide(path, (address) =>
        advapi.symbols.RegDeleteTreeW(HKEY_CURRENT_USER, address),
      );
      if (result !== ERROR_FILE_NOT_FOUND && result !== ERROR_PATH_NOT_FOUND) {
        check(result);
      }
    },

    notifyAssociationsChanged(): void {
      active();
      shell.symbols.SHChangeNotify(
        SHCNE_ASSOCCHANGED,
        SHCNF_IDLIST,
        null,
        null,
      );
    },

    /** Unload the libraries after the opener's last call. Repeated calls are safe. */
    dispose(): void {
      owner.dispose();
    },
  };
}
