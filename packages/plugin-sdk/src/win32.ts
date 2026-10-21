import { type FFIFunction, type Pointer, ptr } from "bun:ffi";

/**
 * Shared Win32 FFI building blocks for Windows platform code. Importing this module opens
 * no library: each adapter still calls `dlopen` and owns the handle for its lifetime, but
 * composes the symbol table from the signatures below so a Win64 signature is written once.
 *
 * Handles are passed as `u64`, pointers as `ptr`, BOOL results as `i32` and HRESULTs as
 * `i32`, matching the conventions of the native host.
 */

/**
 * A window handle returned by `CreateWindowExW`. The brand keeps an HWND apart from the other
 * `u64` handles a plugin holds; apply it once where the window is created.
 */
export type Hwnd = bigint & {
  readonly __brand: "HWND";
};

/** A kernel object handle from `CreateEventW`, `CreateFileW` or `OpenProcess`, closed by `CloseHandle`. */
export type Handle = bigint & {
  readonly __brand: "HANDLE";
};

/** Build a NUL-terminated UTF-16LE buffer for Win32 W functions. */
export const wide = (text: string) => Buffer.from(`${text}\0`, "utf16le");

const nativeBuffers = new Set<Buffer>();

/** Hold the buffer until the synchronous native call returns. */
export function withBuffer<T extends number | bigint>(
  buffer: Buffer,
  invoke: (address: Pointer) => T,
): T {
  nativeBuffers.add(buffer);
  try {
    return invoke(ptr(buffer));
  } finally {
    nativeBuffers.delete(buffer);
  }
}

/** Pass a temporary UTF-16LE string buffer to a synchronous native call. */
export function withWide<T extends number | bigint>(
  text: string,
  invoke: (address: Pointer) => T,
): T {
  return withBuffer(wide(text), invoke);
}

/** Reported by `win32CallError` when a failed call left no readable error. */
export const WIN32_ERROR_UNKNOWN = 0xffffffff;

/**
 * Run a Win32 call that returns a BOOL-style result and give the error it left behind.
 * Returns 0 when the call succeeded. A failing call always leaves a nonzero last error, so a
 * zero read means Bun's FFI layer overwrote it between the call and `GetLastError` (the first
 * read can run a cold thunk that resets it). The call is then repeated once, which is only
 * valid for idempotent calls, and the error read again.
 */
export function win32CallError(
  call: () => number | bigint,
  readError: () => number,
): number {
  if (call()) {
    return 0;
  }
  let code = readError();
  if (code === 0) {
    if (call()) {
      return 0;
    }
    code = readError();
  }
  return code === 0 ? WIN32_ERROR_UNKNOWN : code;
}

/** Format an HRESULT the way Windows tools print it, as unsigned hexadecimal. */
export function hresultText(value: number): string {
  return `0x${(value >>> 0).toString(16)}`;
}

/** Throw with the operation name when a COM HRESULT reports failure. */
export function checkHresult(value: number, operation: string): void {
  if (value < 0) {
    throw new Error(`${operation}: ${hresultText(value)}`);
  }
}

/** Select the named signatures of a shared table for one `dlopen` call. */
export function pick<
  Table extends Record<string, FFIFunction>,
  Name extends keyof Table,
>(table: Table, ...names: Name[]): Pick<Table, Name> {
  const selected = {} as Pick<Table, Name>;
  for (const name of names) {
    selected[name] = table[name];
  }
  return selected;
}

/** kernel32.dll: handles, events, files, processes, Job objects and global memory. */
export const KERNEL32 = {
  CloseHandle: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
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
  CreateEventW: {
    args: [
      "ptr",
      "i32",
      "i32",
      "ptr",
    ],
    returns: "u64",
  },
  CreateFileW: {
    args: [
      "ptr",
      "u32",
      "u32",
      "ptr",
      "u32",
      "u32",
      "u64",
    ],
    returns: "u64",
  },
  CreateJobObjectW: {
    args: [
      "ptr",
      "ptr",
    ],
    returns: "u64",
  },
  CreateProcessW: {
    args: [
      "ptr",
      "ptr",
      "ptr",
      "ptr",
      "i32",
      "u32",
      "ptr",
      "ptr",
      "ptr",
      "ptr",
    ],
    returns: "i32",
  },
  GetCurrentPackageFullName: {
    args: [
      "ptr",
      "ptr",
    ],
    returns: "i32",
  },
  GetCurrentProcess: {
    args: [],
    returns: "u64",
  },
  GetDriveTypeW: {
    args: [
      "ptr",
    ],
    returns: "u32",
  },
  GetFileInformationByHandle: {
    args: [
      "u64",
      "ptr",
    ],
    returns: "i32",
  },
  GetFinalPathNameByHandleW: {
    args: [
      "u64",
      "ptr",
      "u32",
      "u32",
    ],
    returns: "u32",
  },
  GetLastError: {
    args: [],
    returns: "u32",
  },
  GetModuleHandleW: {
    args: [
      "ptr",
    ],
    returns: "u64",
  },
  GlobalAlloc: {
    args: [
      "u32",
      "u64",
    ],
    returns: "ptr",
  },
  GlobalFree: {
    args: [
      "ptr",
    ],
    returns: "ptr",
  },
  GlobalLock: {
    args: [
      "ptr",
    ],
    returns: "ptr",
  },
  GlobalSize: {
    args: [
      "ptr",
    ],
    returns: "u64",
  },
  GlobalUnlock: {
    args: [
      "ptr",
    ],
    returns: "i32",
  },
  LocalFree: {
    args: [
      "ptr",
    ],
    returns: "ptr",
  },
  MoveFileExW: {
    args: [
      "ptr",
      "ptr",
      "u32",
    ],
    returns: "i32",
  },
  OpenProcess: {
    args: [
      "u32",
      "i32",
      "u32",
    ],
    returns: "u64",
  },
  QueryInformationJobObject: {
    args: [
      "u64",
      "i32",
      "ptr",
      "u32",
      "ptr",
    ],
    returns: "i32",
  },
  ReadFile: {
    args: [
      "u64",
      "ptr",
      "u32",
      "ptr",
      "ptr",
    ],
    returns: "i32",
  },
  SetInformationJobObject: {
    args: [
      "u64",
      "i32",
      "ptr",
      "u32",
    ],
    returns: "i32",
  },
  SetLastError: {
    args: [
      "u32",
    ],
    returns: "void",
  },
  WaitForSingleObject: {
    args: [
      "u64",
      "u32",
    ],
    returns: "u32",
  },
  WriteFile: {
    args: [
      "u64",
      "ptr",
      "u32",
      "ptr",
      "ptr",
    ],
    returns: "i32",
  },
} as const satisfies Record<string, FFIFunction>;

/** user32.dll: windows, messages, timers, icons, menus and the clipboard. */
export const USER32 = {
  CloseClipboard: {
    args: [],
    returns: "i32",
  },
  CreateWindowExW: {
    args: [
      "u32",
      "ptr",
      "ptr",
      "u32",
      "i32",
      "i32",
      "i32",
      "i32",
      "u64",
      "u64",
      "u64",
      "ptr",
    ],
    returns: "u64",
  },
  DestroyIcon: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
  DestroyWindow: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
  DrawMenuBar: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
  EmptyClipboard: {
    args: [],
    returns: "i32",
  },
  GetAsyncKeyState: {
    args: [
      "i32",
    ],
    returns: "i16",
  },
  GetClipboardData: {
    args: [
      "u32",
    ],
    returns: "ptr",
  },
  GetCursorPos: {
    args: [
      "ptr",
    ],
    returns: "i32",
  },
  GetDC: {
    args: [
      "u64",
    ],
    returns: "u64",
  },
  IsClipboardFormatAvailable: {
    args: [
      "u32",
    ],
    returns: "i32",
  },
  IsWindowEnabled: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
  KillTimer: {
    args: [
      "u64",
      "u64",
    ],
    returns: "i32",
  },
  LoadIconW: {
    args: [
      "u64",
      "u64",
    ],
    returns: "u64",
  },
  MessageBoxW: {
    args: [
      "u64",
      "ptr",
      "ptr",
      "u32",
    ],
    returns: "i32",
  },
  OpenClipboard: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
  PeekMessageW: {
    args: [
      "ptr",
      "u64",
      "u32",
      "u32",
      "u32",
    ],
    returns: "i32",
  },
  PostMessageW: {
    args: [
      "u64",
      "u32",
      "u64",
      "i64",
    ],
    returns: "i32",
  },
  RegisterClipboardFormatW: {
    args: [
      "ptr",
    ],
    returns: "u32",
  },
  RegisterWindowMessageW: {
    args: [
      "ptr",
    ],
    returns: "u32",
  },
  ReleaseCapture: {
    args: [],
    returns: "i32",
  },
  ReleaseDC: {
    args: [
      "u64",
      "u64",
    ],
    returns: "i32",
  },
  SendMessageW: {
    args: [
      "u64",
      "u32",
      "u64",
      "i64",
    ],
    returns: "i64",
  },
  SetClipboardData: {
    args: [
      "u32",
      "ptr",
    ],
    returns: "ptr",
  },
  SetForegroundWindow: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
  SetTimer: {
    args: [
      "u64",
      "u64",
      "u32",
      "ptr",
    ],
    returns: "u64",
  },
} as const satisfies Record<string, FFIFunction>;

/**
 * user32.dll popup menu functions, kept apart from `USER32` so a host built without the
 * optional menu and tray plugins carries no menu implementation.
 */
export const USER32_MENUS = {
  TrackPopupMenuEx: {
    args: [
      "u64",
      "u32",
      "i32",
      "i32",
      "u64",
      "ptr",
    ],
    returns: "u32",
  },
} as const satisfies Record<string, FFIFunction>;

/** gdi32.dll: device contexts, device-independent bitmaps and the objects selected into them. */
export const GDI32 = {
  CreateCompatibleDC: {
    args: [
      "u64",
    ],
    returns: "u64",
  },
  CreateDIBSection: {
    args: [
      "u64",
      "ptr",
      "u32",
      "ptr",
      "u64",
      "u32",
    ],
    returns: "u64",
  },
  DeleteDC: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
  DeleteObject: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
  GdiFlush: {
    args: [],
    returns: "i32",
  },
  SelectObject: {
    args: [
      "u64",
      "u64",
    ],
    returns: "u64",
  },
} as const satisfies Record<string, FFIFunction>;

/** ole32.dll: COM apartments, activation and task memory. */
export const OLE32 = {
  CoCreateInstance: {
    args: [
      "ptr",
      "ptr",
      "u32",
      "ptr",
      "ptr",
    ],
    returns: "i32",
  },
  CoInitializeEx: {
    args: [
      "ptr",
      "u32",
    ],
    returns: "i32",
  },
  CoRegisterClassObject: {
    args: [
      "ptr",
      "ptr",
      "u32",
      "u32",
      "ptr",
    ],
    returns: "i32",
  },
  CoRevokeClassObject: {
    args: [
      "u32",
    ],
    returns: "i32",
  },
  CoTaskMemFree: {
    args: [
      "ptr",
    ],
    returns: "void",
  },
  CoUninitialize: {
    args: [],
    returns: "void",
  },
} as const satisfies Record<string, FFIFunction>;

/** shell32.dll: known folders and shell items. */
export const SHELL32 = {
  SHChangeNotify: {
    args: [
      "i32",
      "u32",
      "ptr",
      "ptr",
    ],
    returns: "void",
  },
  SHCreateItemFromParsingName: {
    args: [
      "ptr",
      "ptr",
      "ptr",
      "ptr",
    ],
    returns: "i32",
  },
  SHGetKnownFolderPath: {
    args: [
      "ptr",
      "u32",
      "u64",
      "ptr",
    ],
    returns: "i32",
  },
} as const satisfies Record<string, FFIFunction>;

/** combase.dll: Windows Runtime initialization, activation and HSTRINGs. */
export const COMBASE = {
  RoGetActivationFactory: {
    args: [
      "ptr",
      "ptr",
      "ptr",
    ],
    returns: "i32",
  },
  RoInitialize: {
    args: [
      "u32",
    ],
    returns: "i32",
  },
  RoUninitialize: {
    args: [],
    returns: "void",
  },
  WindowsCreateString: {
    args: [
      "ptr",
      "u32",
      "ptr",
    ],
    returns: "i32",
  },
  WindowsDeleteString: {
    args: [
      "ptr",
    ],
    returns: "i32",
  },
  WindowsGetStringRawBuffer: {
    args: [
      "ptr",
      "ptr",
    ],
    returns: "ptr",
  },
} as const satisfies Record<string, FFIFunction>;

/** advapi32.dll: registry access. */
export const ADVAPI32 = {
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
  RegDeleteTreeW: {
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
  RegGetValueW: {
    args: [
      "u64",
      "ptr",
      "ptr",
      "u32",
      "ptr",
      "ptr",
      "ptr",
    ],
    returns: "i32",
  },
} as const satisfies Record<string, FFIFunction>;

/** COM apartment models passed to CoInitializeEx. */
export const COINIT_APARTMENTTHREADED = 0x2;
export const COINIT_MULTITHREADED = 0x0;
