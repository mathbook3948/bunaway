import { dlopen, type Pointer, ptr } from "bun:ffi";

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
/** Throw with the operation name when a COM HRESULT reports failure. */
export function hr(value: number, operation: string): void {
  if (value < 0) {
    throw new Error(`${operation}: 0x${(value >>> 0).toString(16)}`);
  }
}
export const kernel = dlopen("kernel32.dll", {
  GetModuleHandleW: {
    args: [
      "ptr",
    ],
    returns: "u64",
  },
  GetCurrentThreadId: {
    args: [],
    returns: "u32",
  },
  GetLastError: {
    args: [],
    returns: "u32",
  },
  SetLastError: {
    args: [
      "u32",
    ],
    returns: "void",
  },
  OpenProcess: {
    args: [
      "u32",
      "i32",
      "u32",
    ],
    returns: "u64",
  },
  WaitForSingleObject: {
    args: [
      "u64",
      "u32",
    ],
    returns: "u32",
  },
  CloseHandle: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
});
export const ole = dlopen("ole32.dll", {
  CoInitializeEx: {
    args: [
      "ptr",
      "u32",
    ],
    returns: "i32",
  },
  CoUninitialize: {
    args: [],
    returns: "void",
  },
  CoTaskMemFree: {
    args: [
      "ptr",
    ],
    returns: "void",
  },
});
export const user = dlopen("user32.dll", {
  EnableWindow: {
    args: [
      "u64",
      "i32",
    ],
    returns: "i32",
  },
  IsWindowEnabled: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
  GetWindow: {
    args: [
      "u64",
      "u32",
    ],
    returns: "u64",
  },
  SetThreadDpiAwarenessContext: {
    args: [
      "i64",
    ],
    returns: "i64",
  },
  RegisterClassExW: {
    args: [
      "ptr",
    ],
    returns: "u16",
  },
  UnregisterClassW: {
    args: [
      "ptr",
      "u64",
    ],
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
  DefWindowProcW: {
    args: [
      "u64",
      "u32",
      "u64",
      "i64",
    ],
    returns: "i64",
  },
  RegisterWindowMessageW: {
    args: [
      "ptr",
    ],
    returns: "u32",
  },
  LoadIconW: {
    args: [
      "u64",
      "u64",
    ],
    returns: "u64",
  },
  LoadImageW: {
    args: [
      "u64",
      "ptr",
      "u32",
      "i32",
      "i32",
      "u32",
    ],
    returns: "u64",
  },
  DestroyIcon: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
  CreatePopupMenu: {
    args: [],
    returns: "u64",
  },
  AppendMenuW: {
    args: [
      "u64",
      "u32",
      "u64",
      "ptr",
    ],
    returns: "i32",
  },
  DestroyMenu: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
  GetCursorPos: {
    args: [
      "ptr",
    ],
    returns: "i32",
  },
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
  ShowWindow: {
    args: [
      "u64",
      "i32",
    ],
    returns: "i32",
  },
  SetForegroundWindow: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
  IsIconic: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
  IsWindow: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
  GetForegroundWindow: {
    args: [],
    returns: "u64",
  },
  IsZoomed: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
  IsWindowVisible: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
  GetDpiForWindow: {
    args: [
      "u64",
    ],
    returns: "u32",
  },
  GetSystemMetricsForDpi: {
    args: [
      "i32",
      "u32",
    ],
    returns: "i32",
  },
  GetWindowRect: {
    args: [
      "u64",
      "ptr",
    ],
    returns: "i32",
  },
  ClientToScreen: {
    args: [
      "u64",
      "ptr",
    ],
    returns: "i32",
  },
  SetWindowPos: {
    args: [
      "u64",
      "u64",
      "i32",
      "i32",
      "i32",
      "i32",
      "u32",
    ],
    returns: "i32",
  },
  GetWindowLongPtrW: {
    args: [
      "u64",
      "i32",
    ],
    returns: "i64",
  },
  SetWindowLongPtrW: {
    args: [
      "u64",
      "i32",
      "i64",
    ],
    returns: "i64",
  },
  GetWindowPlacement: {
    args: [
      "u64",
      "ptr",
    ],
    returns: "i32",
  },
  SetWindowPlacement: {
    args: [
      "u64",
      "ptr",
    ],
    returns: "i32",
  },
  MonitorFromWindow: {
    args: [
      "u64",
      "u32",
    ],
    returns: "u64",
  },
  MonitorFromRect: {
    args: [
      "ptr",
      "u32",
    ],
    returns: "u64",
  },
  GetMonitorInfoW: {
    args: [
      "u64",
      "ptr",
    ],
    returns: "i32",
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
  DestroyWindow: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
  GetClientRect: {
    args: [
      "u64",
      "ptr",
    ],
    returns: "i32",
  },
  AdjustWindowRectExForDpi: {
    args: [
      "ptr",
      "u32",
      "i32",
      "u32",
      "u32",
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
  TranslateMessage: {
    args: [
      "ptr",
    ],
    returns: "i32",
  },
  DispatchMessageW: {
    args: [
      "ptr",
    ],
    returns: "i64",
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
});

/** Close native library handles after releasing the owning resources. */
export function disposeWin32Bindings() {
  user.close();
  ole.close();
  kernel.close();
}
