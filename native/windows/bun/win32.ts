import { dlopen, JSCallback, ptr, type Pointer } from "bun:ffi";
import assert from "node:assert/strict";
import { APP_SHUTDOWN_MESSAGE } from "./channel.ts";

export const wide = (text: string) => Buffer.from(`${text}\0`, "utf16le");
const nativeBuffers = new Set<Buffer>();
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
export function withWide<T extends number | bigint>(
  text: string,
  invoke: (address: Pointer) => T,
): T {
  return withBuffer(wide(text), invoke);
}
export function hr(value: number, operation: string): void {
  if (value < 0) throw new Error(`${operation}: 0x${(value >>> 0).toString(16)}`);
}
export const kernel = dlopen("kernel32.dll", {
  GetModuleHandleW: { args: ["ptr"], returns: "u64" },
  GetCurrentThreadId: { args: [], returns: "u32" },
  GetLastError: { args: [], returns: "u32" },
  OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
  WaitForSingleObject: { args: ["u64", "u32"], returns: "u32" },
  CloseHandle: { args: ["u64"], returns: "i32" },
});
export const ole = dlopen("ole32.dll", {
  CoInitializeEx: { args: ["ptr", "u32"], returns: "i32" },
  CoUninitialize: { args: [], returns: "void" },
  CoTaskMemFree: { args: ["ptr"], returns: "void" },
});
export const user = dlopen("user32.dll", {
  RegisterClassExW: { args: ["ptr"], returns: "u16" },
  UnregisterClassW: { args: ["ptr", "u64"], returns: "i32" },
  CreateWindowExW: {
    args: ["u32", "ptr", "ptr", "u32", "i32", "i32", "i32", "i32", "u64", "u64", "u64", "ptr"],
    returns: "u64",
  },
  DefWindowProcW: { args: ["u64", "u32", "u64", "i64"], returns: "i64" },
  SetForegroundWindow: { args: ["u64"], returns: "i32" },
  IsIconic: { args: ["u64"], returns: "i32" },
  RegisterWindowMessageW: { args: ["ptr"], returns: "u32" },
  LoadIconW: { args: ["u64", "u64"], returns: "u64" },
  CreatePopupMenu: { args: [], returns: "u64" },
  AppendMenuW: { args: ["u64", "u32", "u64", "ptr"], returns: "i32" },
  DestroyMenu: { args: ["u64"], returns: "i32" },
  GetCursorPos: { args: ["ptr"], returns: "i32" },
  TrackPopupMenuEx: { args: ["u64", "u32", "i32", "i32", "u64", "ptr"], returns: "u32" },
  ShowWindow: { args: ["u64", "i32"], returns: "i32" },
  DestroyWindow: { args: ["u64"], returns: "i32" },
  GetClientRect: { args: ["u64", "ptr"], returns: "i32" },
  AdjustWindowRect: { args: ["ptr", "u32", "i32"], returns: "i32" },
  PeekMessageW: { args: ["ptr", "u64", "u32", "u32", "u32"], returns: "i32" },
  TranslateMessage: { args: ["ptr"], returns: "i32" },
  DispatchMessageW: { args: ["ptr"], returns: "i64" },
  PostMessageW: { args: ["u64", "u32", "u64", "i64"], returns: "i32" },
});

// One class and one bounded pump per STA, shared by every view.
export class Windows {
  readonly thread = kernel.symbols.GetCurrentThreadId();
  private readonly instance = kernel.symbols.GetModuleHandleW(null);
  private readonly name = wide(`bunaway-bun-${process.pid}-${this.thread}`);
  private readonly message = Buffer.alloc(48); // MSG, Win64
  private readonly windows = new Map<
    bigint,
    (message: number, wparam: bigint, lparam: bigint) => void
  >();
  private readonly callback: JSCallback;
  private registered = false;
  failure: unknown;

  constructor(shutdown: () => void) {
    this.callback = new JSCallback(
      (window: bigint, message: number, wparam: bigint, lparam: bigint) => {
        try {
          assert.equal(kernel.symbols.GetCurrentThreadId(), this.thread);
          if (message === APP_SHUTDOWN_MESSAGE) {
            shutdown();
            return 0n;
          }
          this.windows.get(window)?.(message, wparam, lparam);
          if (message === 0x10) return 0n; // defer Close/DestroyWindow past callback
          return user.symbols.DefWindowProcW(window, message, wparam, lparam);
        } catch (error) {
          this.failure ??= error;
          return 0n;
        }
      },
      { args: ["u64", "u32", "u64", "i64"], returns: "i64" },
    );
    const wc = Buffer.alloc(80); // WNDCLASSEXW, Win64
    wc.writeUInt32LE(80, 0);
    wc.writeBigUInt64LE(BigInt(this.callback.ptr ?? 0), 8);
    wc.writeBigUInt64LE(this.instance, 24);
    wc.writeBigUInt64LE(6n, 48); // COLOR_WINDOW + 1
    wc.writeBigUInt64LE(BigInt(ptr(this.name)), 64);
    if (!user.symbols.RegisterClassExW(ptr(wc))) {
      this.callback.close();
      throw new Error(`RegisterClassExW: ${kernel.symbols.GetLastError()}`);
    }
    this.registered = true;
  }

  create(
    title: string,
    width: number,
    height: number,
    receive: (message: number, wparam: bigint, lparam: bigint) => void,
    visible = true,
  ) {
    const rect = new Int32Array([0, 0, width, height]);
    assert(user.symbols.AdjustWindowRect(ptr(rect), 0xcf0000, 0));
    const window = withWide(title, (titlePointer) =>
      user.symbols.CreateWindowExW(
        0,
        ptr(this.name),
        titlePointer,
        0xcf0000,
        -2147483648,
        -2147483648,
        (rect[2] ?? 0) - (rect[0] ?? 0),
        (rect[3] ?? 0) - (rect[1] ?? 0),
        0n,
        0n,
        this.instance,
        null,
      ),
    );
    assert(window, `CreateWindowExW: ${kernel.symbols.GetLastError()}`);
    this.windows.set(window, receive);
    if (visible) user.symbols.ShowWindow(window, 5);
    return window;
  }

  destroy(window: bigint) {
    assert(user.symbols.DestroyWindow(window));
    this.windows.delete(window);
  }

  pump() {
    for (
      let count = 0;
      count < 64 && user.symbols.PeekMessageW(ptr(this.message), 0n, 0, 0, 1);
      count++
    ) {
      if (this.message.readUInt32LE(8) === 0x12) throw new Error("Unexpected WM_QUIT");
      user.symbols.TranslateMessage(ptr(this.message));
      user.symbols.DispatchMessageW(ptr(this.message));
    }
    if (this.failure) throw this.failure;
  }

  dispose() {
    assert.equal(this.windows.size, 0);
    if (this.registered) assert(user.symbols.UnregisterClassW(ptr(this.name), this.instance));
    this.registered = false;
    this.callback.close();
  }
}
export function disposeWin32Bindings() {
  user.close();
  ole.close();
  kernel.close();
}
