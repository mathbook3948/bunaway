import { dlopen, type Pointer, ptr, read, toArrayBuffer } from "bun:ffi";
import { toUSVString } from "node:util";
import { ADVAPI32, KERNEL32, pick } from "@bunaway/plugin/win32";
import { AUTOSTART_MUTEX_PREFIX, BunawayError } from "@bunaway/protocol";
export const RUN_KEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const APPROVAL_KEY =
  "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
const HKEY_CURRENT_USER = 0xffffffff80000001n;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_SUCCESS = 0;
const APPMODEL_ERROR_NO_PACKAGE = 15700;
const REG_SZ = 1;
const REG_BINARY = 3;
const KEY_SET_VALUE_64 = 0x0002 | 0x0100;
const READ_RAW_64 = 0x0000ffff | 0x10000000 | 0x00010000;
const MAX_VALUE_BYTES = 65536;
const APPROVAL_BYTES = 12;
const TOKEN_QUERY = 0x0008;
const TOKEN_USER = 1;
const TOKEN_USER_BUFFER_BYTES = 256;
const MAX_SID_STRING_UNITS = 256;
const MUTEX_ACCESS = 0x00100000 | 0x0001;
const WAIT_ACQUIRED = 0;
const WAIT_ABANDONED = 128;
const WAIT_TIMEOUT = 258;

function wide(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf16le");
}

function check(result: number): void {
  if (result !== ERROR_SUCCESS) {
    throw new BunawayError({
      code: result === ERROR_ACCESS_DENIED ? "PERMISSION_DENIED" : "INTERNAL",
      message: "Windows autostart registry operation failed.",
    });
  }
}

/**
 * Own the registry and argv DLLs for one adapter. Values use the native 64-bit view.
 * Never create or write StartupApproved: its format is not a supported Windows API.
 */
export function createRegistry() {
  const registry = dlopen("advapi32.dll", {
    ...pick(ADVAPI32, "RegGetValueW"),
    OpenProcessToken: {
      args: [
        "u64",
        "u32",
        "ptr",
      ],
      returns: "i32",
    },
    GetTokenInformation: {
      args: [
        "u64",
        "u32",
        "ptr",
        "u32",
        "ptr",
      ],
      returns: "i32",
    },
    ConvertSidToStringSidW: {
      args: [
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
    RegCreateKeyExW: {
      args: [
        "u64",
        "ptr",
        "u32",
        "ptr",
        "u32",
        "u32",
        "ptr",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
    RegOpenKeyExW: {
      args: [
        "u64",
        "ptr",
        "u32",
        "u32",
        "ptr",
      ],
      returns: "i32",
    },
    RegSetValueExW: {
      args: [
        "u64",
        "ptr",
        "u32",
        "u32",
        "ptr",
        "u32",
      ],
      returns: "i32",
    },
    RegDeleteValueW: {
      args: [
        "u64",
        "ptr",
      ],
      returns: "i32",
    },
    RegCloseKey: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
  });
  let shell: ReturnType<typeof loadShell>;
  let kernel: ReturnType<typeof loadKernel>;
  try {
    shell = loadShell();
    try {
      kernel = loadKernel();
    } catch (error) {
      shell.close();
      throw error;
    }
  } catch (error) {
    registry.close();
    throw error;
  }
  let userSid: string | undefined;
  let disposed = false;
  function active(): void {
    if (disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Autostart adapter is disposed.",
      });
    }
  }
  /** Check and mutate one Run identity while all participating processes are excluded. */
  function withRunLock<T>(name: string, work: () => T): T {
    active();
    userSid ??= currentUserSid(registry.symbols, kernel.symbols);
    const mutexName = wide(`${AUTOSTART_MUTEX_PREFIX}${userSid}.${name}`);
    const handle = kernel.symbols.CreateMutexExW(
      null,
      ptr(mutexName),
      0,
      MUTEX_ACCESS,
    );
    if (!handle) {
      check(kernel.symbols.GetLastError());
      throw new BunawayError({
        code: "INTERNAL",
        message: "Could not create autostart mutex.",
      });
    }
    let owned = false;
    try {
      // Keep cancellation and unrelated I/O operations responsive. Contention
      // returns BUSY immediately; only installers wait for another writer.
      const result = kernel.symbols.WaitForSingleObject(handle, 0);
      if (result === WAIT_TIMEOUT) {
        throw new BunawayError({
          code: "BUSY",
          message:
            "Another process is maintaining this autostart registration.",
        });
      }
      owned = result === WAIT_ACQUIRED || result === WAIT_ABANDONED;
      if (!owned) {
        check(kernel.symbols.GetLastError());
        throw new BunawayError({
          code: "INTERNAL",
          message: "Could not acquire autostart mutex.",
        });
      }
      return work();
    } finally {
      try {
        if (owned && !kernel.symbols.ReleaseMutex(handle)) {
          check(kernel.symbols.GetLastError());
        }
      } finally {
        if (!kernel.symbols.CloseHandle(handle)) {
          check(kernel.symbols.GetLastError());
        }
      }
    }
  }
  return {
    withRunLock,
    /** Whether the process has MSIX package identity, which routes autostart to the manifest StartupTask. */
    packaged(): boolean {
      active();
      const size = new Uint32Array(1);
      const result = kernel.symbols.GetCurrentPackageFullName(ptr(size), null);
      if (result === APPMODEL_ERROR_NO_PACKAGE) {
        return false;
      }
      if (result === ERROR_INSUFFICIENT_BUFFER || result === ERROR_SUCCESS) {
        return true;
      }
      check(result);
      return false;
    },
    read(
      key: string,
      name: string,
    ): {
      type: number;
      data: Buffer;
    } | null {
      active();
      const path = wide(key);
      const value = wide(name);
      const type = new Uint32Array(1);
      // A single bounded read avoids size/read races when Task Manager changes approval.
      const data = Buffer.alloc(MAX_VALUE_BYTES);
      const size = new Uint32Array([
        data.length,
      ]);
      const result = registry.symbols.RegGetValueW(
        HKEY_CURRENT_USER,
        ptr(path),
        ptr(value),
        READ_RAW_64,
        ptr(type),
        ptr(data),
        ptr(size),
      );
      if (result === ERROR_FILE_NOT_FOUND || result === ERROR_PATH_NOT_FOUND) {
        return null;
      }
      check(result);
      return {
        type: type[0] ?? 0,
        data: data.subarray(0, size[0]),
      };
    },
    write(name: string, command: string): void {
      withRunLock(name, () => {
        const path = wide(RUN_KEY);
        const value = wide(name);
        const data = wide(command);
        const handle = new BigUint64Array(1);
        check(
          registry.symbols.RegCreateKeyExW(
            HKEY_CURRENT_USER,
            ptr(path),
            0,
            null,
            0,
            KEY_SET_VALUE_64,
            null,
            ptr(handle),
            null,
          ),
        );
        try {
          check(
            registry.symbols.RegSetValueExW(
              handle[0] ?? 0n,
              ptr(value),
              0,
              REG_SZ,
              ptr(data),
              data.length,
            ),
          );
        } finally {
          check(registry.symbols.RegCloseKey(handle[0] ?? 0n));
        }
      });
    },
    remove(name: string): void {
      withRunLock(name, () => {
        const path = wide(RUN_KEY);
        const value = wide(name);
        const handle = new BigUint64Array(1);
        const result = registry.symbols.RegOpenKeyExW(
          HKEY_CURRENT_USER,
          ptr(path),
          0,
          KEY_SET_VALUE_64,
          ptr(handle),
        );
        if (
          result === ERROR_FILE_NOT_FOUND ||
          result === ERROR_PATH_NOT_FOUND
        ) {
          return;
        }
        check(result);
        try {
          const deleted = registry.symbols.RegDeleteValueW(
            handle[0] ?? 0n,
            ptr(value),
          );
          if (deleted !== ERROR_FILE_NOT_FOUND) {
            check(deleted);
          }
        } finally {
          check(registry.symbols.RegCloseKey(handle[0] ?? 0n));
        }
      });
    },
    parse(command: string): string[] {
      active();
      const count = new Int32Array(1);
      const input = wide(command);
      const address = shell.symbols.CommandLineToArgvW(ptr(input), ptr(count));
      if (!address) {
        throw new BunawayError({
          code: "INTERNAL",
          message: "Windows autostart command parsing failed.",
        });
      }
      try {
        const args: string[] = [];
        for (let index = 0; index < (count[0] ?? 0); index++) {
          const item = Number(read.u64(address, index * 8)) as Pointer;
          let bytes = 0;
          while (bytes < MAX_VALUE_BYTES && read.u16(item, bytes)) {
            bytes += 2;
          }
          if (bytes === MAX_VALUE_BYTES) {
            throw new BunawayError({
              code: "INTERNAL",
              message: "Autostart argument exceeds read limit.",
            });
          }
          args.push(
            bytes
              ? Buffer.from(toArrayBuffer(item, 0, bytes)).toString("utf16le")
              : "",
          );
        }
        return args;
      } finally {
        kernel.symbols.LocalFree(address);
      }
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      registry.close();
      shell.close();
      kernel.close();
    },
  };
}

function loadShell() {
  return dlopen("shell32.dll", {
    CommandLineToArgvW: {
      args: [
        "ptr",
        "ptr",
      ],
      returns: "ptr",
    },
  });
}
function loadKernel() {
  return dlopen("kernel32.dll", {
    ...pick(
      KERNEL32,
      "GetCurrentProcess",
      "GetLastError",
      "CloseHandle",
      "WaitForSingleObject",
      "LocalFree",
      "GetCurrentPackageFullName",
    ),
    CreateMutexExW: {
      args: [
        "ptr",
        "ptr",
        "u32",
        "u32",
      ],
      returns: "u64",
    },
    ReleaseMutex: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
  });
}

/** Resolve the effective process user's stable SID without relying on environment names. */
function currentUserSid(
  registry: {
    OpenProcessToken: (
      process: number | bigint,
      access: number,
      token: Pointer,
    ) => number;
    GetTokenInformation: (
      token: number | bigint,
      kind: number,
      data: Pointer,
      bytes: number,
      size: Pointer,
    ) => number;
    ConvertSidToStringSidW: (sid: Pointer, text: Pointer) => number;
  },
  kernel: ReturnType<typeof loadKernel>["symbols"],
): string {
  const token = new BigUint64Array(1);
  if (
    !registry.OpenProcessToken(
      kernel.GetCurrentProcess(),
      TOKEN_QUERY,
      ptr(token),
    )
  ) {
    check(kernel.GetLastError());
    throw new BunawayError({
      code: "INTERNAL",
      message: "Could not inspect autostart user token.",
    });
  }
  try {
    // TOKEN_USER contains one SID_AND_ATTRIBUTES plus a SID of at most 68 bytes.
    const info = Buffer.alloc(TOKEN_USER_BUFFER_BYTES);
    const size = new Uint32Array(1);
    if (
      !registry.GetTokenInformation(
        token[0] ?? 0n,
        TOKEN_USER,
        ptr(info),
        info.length,
        ptr(size),
      )
    ) {
      check(kernel.GetLastError());
      throw new BunawayError({
        code: "INTERNAL",
        message: "Could not read autostart user SID.",
      });
    }
    const textAddress = new BigUint64Array(1);
    // The native TOKEN_USER starts with a SID pointer into the owned info buffer.
    const sid = Number(info.readBigUInt64LE(0)) as Pointer;
    if (!registry.ConvertSidToStringSidW(sid, ptr(textAddress))) {
      check(kernel.GetLastError());
      throw new BunawayError({
        code: "INTERNAL",
        message: "Could not format autostart user SID.",
      });
    }
    const address = Number(textAddress[0]) as Pointer;
    try {
      let units = 0;
      while (units < MAX_SID_STRING_UNITS && read.u16(address, units * 2)) {
        units++;
      }
      if (units === MAX_SID_STRING_UNITS) {
        throw new BunawayError({
          code: "INTERNAL",
          message: "Autostart user SID exceeds its read limit.",
        });
      }
      return Buffer.from(toArrayBuffer(address, 0, units * 2)).toString(
        "utf16le",
      );
    } finally {
      kernel.LocalFree(address);
    }
  } finally {
    if (!kernel.CloseHandle(token[0] ?? 0n)) {
      check(kernel.GetLastError());
    }
  }
}

/** Read only strict REG_SZ, keeping invalid external edits separate from an absent value. */
export function registryCommand(
  value: {
    type: number;
    data: Buffer;
  } | null,
): string | null {
  if (
    !value ||
    value.type !== REG_SZ ||
    value.data.length < 2 ||
    value.data.length % 2 !== 0 ||
    value.data.readUInt16LE(value.data.length - 2) !== 0
  ) {
    return null;
  }
  const text = value.data.subarray(0, -2).toString("utf16le");
  return text && !text.includes("\0") && toUSVString(text) === text
    ? text
    : null;
}

/** Only known 12-byte states are interpreted. Absent, malformed and future formats stay unknown. */
export function startupState(
  value: {
    type: number;
    data: Buffer;
  } | null,
): "enabled" | "disabled" | "unknown" {
  if (
    !value ||
    value.type !== REG_BINARY ||
    value.data.length !== APPROVAL_BYTES
  ) {
    return "unknown";
  }
  const state = value.data.readUInt32LE(0);
  // Settings on Server 2022 uses 0/1; also retain the known 2/3 approval format.
  if (state === 0 || state === 2) {
    return "enabled";
  }
  if (state === 1 || state === 3) {
    return "disabled";
  }
  return "unknown";
}
