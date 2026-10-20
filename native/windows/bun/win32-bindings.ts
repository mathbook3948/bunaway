import { dlopen } from "bun:ffi";
import { KERNEL32, OLE32, pick, USER32 } from "@bunaway/plugin/win32";

export const kernel = dlopen("kernel32.dll", {
  ...pick(
    KERNEL32,
    "GetLastError",
    "OpenProcess",
    "WaitForSingleObject",
    "CloseHandle",
    "GetModuleHandleW",
    "SetLastError",
  ),
  GetCurrentThreadId: {
    args: [],
    returns: "u32",
  },
});
export const ole = dlopen("ole32.dll", {
  ...pick(OLE32, "CoInitializeEx", "CoUninitialize", "CoTaskMemFree"),
});
export const display = dlopen("shcore.dll", {
  GetDpiForMonitor: {
    args: [
      "u64",
      "i32",
      "ptr",
      "ptr",
    ],
    returns: "i32",
  },
});

export const gdi = dlopen("gdi32.dll", {
  GetStockObject: {
    args: [
      "i32",
    ],
    returns: "u64",
  },
  SetDCBrushColor: {
    args: [
      "u64",
      "u32",
    ],
    returns: "u32",
  },
});

export const user = dlopen("user32.dll", {
  ...pick(
    USER32,
    "DrawMenuBar",
    "IsWindowEnabled",
    "RegisterWindowMessageW",
    "LoadIconW",
    "DestroyIcon",
    "GetCursorPos",
    "GetAsyncKeyState",
    "ReleaseCapture",
    "SetForegroundWindow",
    "MessageBoxW",
    "PeekMessageW",
    "PostMessageW",
    "CreateWindowExW",
    "DestroyWindow",
  ),
  EnumDisplayMonitors: {
    args: [
      "u64",
      "ptr",
      "ptr",
      "i64",
    ],
    returns: "i32",
  },
  EnumDisplaySettingsW: {
    args: [
      "ptr",
      "u32",
      "ptr",
    ],
    returns: "i32",
  },
  EnumDisplayDevicesW: {
    args: [
      "ptr",
      "u32",
      "ptr",
      "u32",
    ],
    returns: "i32",
  },
  GetMenu: {
    args: [
      "u64",
    ],
    returns: "u64",
  },
  GetSystemMenu: {
    args: [
      "u64",
      "i32",
    ],
    returns: "u64",
  },
  EnableMenuItem: {
    args: [
      "u64",
      "u32",
      "u32",
    ],
    returns: "u32",
  },
  SetWindowTextW: {
    args: [
      "u64",
      "ptr",
    ],
    returns: "i32",
  },
  GetWindowTextLengthW: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
  GetWindowTextW: {
    args: [
      "u64",
      "ptr",
      "i32",
    ],
    returns: "i32",
  },
  EnableWindow: {
    args: [
      "u64",
      "i32",
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
  DefWindowProcW: {
    args: [
      "u64",
      "u32",
      "u64",
      "i64",
    ],
    returns: "i64",
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
  ShowWindow: {
    args: [
      "u64",
      "i32",
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
  FlashWindowEx: {
    args: [
      "ptr",
    ],
    returns: "i32",
  },
  GetForegroundWindow: {
    args: [],
    returns: "u64",
  },
  GetGUIThreadInfo: {
    args: [
      "u32",
      "ptr",
    ],
    returns: "i32",
  },
  IsChild: {
    args: [
      "u64",
      "u64",
    ],
    returns: "i32",
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
  SetWindowDisplayAffinity: {
    args: [
      "u64",
      "u32",
    ],
    returns: "i32",
  },
  GetWindowDisplayAffinity: {
    args: [
      "u64",
      "ptr",
    ],
    returns: "i32",
  },
  SetLayeredWindowAttributes: {
    args: [
      "u64",
      "u32",
      "u8",
      "u32",
    ],
    returns: "i32",
  },
  GetLayeredWindowAttributes: {
    args: [
      "u64",
      "ptr",
      "ptr",
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
  MonitorFromPoint: {
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
  FillRect: {
    args: [
      "u64",
      "ptr",
      "u64",
    ],
    returns: "i32",
  },
  InvalidateRect: {
    args: [
      "u64",
      "ptr",
      "i32",
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
});

/** Close native library handles after releasing the owning resources. */
export function disposeWin32Bindings() {
  display.close();
  gdi.close();
  user.close();
  ole.close();
  kernel.close();
}
