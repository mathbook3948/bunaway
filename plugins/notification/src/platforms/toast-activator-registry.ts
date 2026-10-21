import { dlopen, ptr } from "bun:ffi";
import { ADVAPI32, pick, wide } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";

const HKEY_CURRENT_USER = 0xffffffff80000001n;
const ERROR_SUCCESS = 0;
const ERROR_ACCESS_DENIED = 5;
const REG_SZ = 1;
const KEY_SET_VALUE = 0x2;
const KEY_WOW64_64KEY = 0x100;

function registryError(code: number, stage: string): BunawayError {
  return new BunawayError({
    code: code === ERROR_ACCESS_DENIED ? "PERMISSION_DENIED" : "INTERNAL",
    message: `Windows registry operation failed (Win32 ${code}).`,
    details: {
      stage,
    },
  });
}

/** Registry path of the activator's `LocalServer32` key in the user's classes hive. */
export function toastActivatorServerKey(clsid: string): string {
  return `Software\\Classes\\CLSID\\{${clsid}}\\LocalServer32`;
}

/**
 * Point the activator class at the running executable so Windows can start the app for a click
 * while it is not running. Only the user's own hive is written, so no administrator rights are needed,
 * and the value is rewritten on every start so a moved installation fixes itself. The key is left in
 * place on exit because the next click needs it; the installer removes it on uninstall.
 * The command is quoted because Windows passes it to CreateProcess.
 */
export function writeToastActivatorServer(
  clsid: string,
  executablePath: string,
): void {
  const advapi = dlopen("advapi32.dll", {
    ...pick(ADVAPI32, "RegCreateKeyExW", "RegSetValueExW", "RegCloseKey"),
  });
  try {
    const key = new BigUint64Array(1);
    const path = wide(toastActivatorServerKey(clsid));
    const created = advapi.symbols.RegCreateKeyExW(
      HKEY_CURRENT_USER,
      ptr(path),
      0,
      null,
      0,
      KEY_SET_VALUE | KEY_WOW64_64KEY,
      null,
      ptr(key),
      null,
    );
    if (created !== ERROR_SUCCESS) {
      throw registryError(created, "RegCreateKeyExW");
    }
    const data = wide(`"${executablePath}"`);
    // A null value name addresses the key's default value.
    const set = advapi.symbols.RegSetValueExW(
      key[0] ?? 0n,
      null,
      0,
      REG_SZ,
      ptr(data),
      data.length,
    );
    const closed = advapi.symbols.RegCloseKey(key[0] ?? 0n);
    // The write failure is the more useful one when closing fails as well.
    if (set !== ERROR_SUCCESS) {
      throw registryError(set, "RegSetValueExW");
    }
    if (closed !== ERROR_SUCCESS) {
      throw registryError(closed, "RegCloseKey");
    }
  } finally {
    advapi.close();
  }
}
