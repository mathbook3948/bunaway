import { dlopen, JSCallback, ptr, type Pointer } from "bun:ffi";
import assert from "node:assert/strict";

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
  ShowWindow: { args: ["u64", "i32"], returns: "i32" },
  SetForegroundWindow: { args: ["u64"], returns: "i32" },
  IsIconic: { args: ["u64"], returns: "i32" },
  GetWindowRect: { args: ["u64", "ptr"], returns: "i32" },
  SetWindowPos: { args: ["u64", "u64", "i32", "i32", "i32", "i32", "u32"], returns: "i32" },
  GetWindowLongPtrW: { args: ["u64", "i32"], returns: "i64" },
  SetWindowLongPtrW: { args: ["u64", "i32", "i64"], returns: "i64" },
  GetWindowPlacement: { args: ["u64", "ptr"], returns: "i32" },
  SetWindowPlacement: { args: ["u64", "ptr"], returns: "i32" },
  MonitorFromWindow: { args: ["u64", "u32"], returns: "u64" },
  GetMonitorInfoW: { args: ["u64", "ptr"], returns: "i32" },
  MessageBoxW: { args: ["u64", "ptr", "ptr", "u32"], returns: "i32" },
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
  private readonly windows = new Map<bigint, (message: number) => void>();
  private readonly callback: JSCallback;
  private readonly fullscreen = new Map<bigint, { style: bigint; placement: Buffer }>();
  private registered = false;
  failure: unknown;

  constructor() {
    this.callback = new JSCallback(
      (window: bigint, message: number, wparam: bigint, lparam: bigint) => {
        try {
          assert.equal(kernel.symbols.GetCurrentThreadId(), this.thread);
          this.windows.get(window)?.(message);
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

  create(title: string, width: number, height: number, receive: (message: number) => void) {
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
    user.symbols.ShowWindow(window, 5);
    return window;
  }

  show(window: bigint, visible: boolean) {
    user.symbols.ShowWindow(window, visible ? 5 : 0);
  }

  focus(window: bigint): boolean {
    user.symbols.ShowWindow(window, user.symbols.IsIconic(window) ? 9 : 5);
    return !!user.symbols.SetForegroundWindow(window);
  }

  setSize(window: bigint, width: number, height: number) {
    const rect = new Int32Array([0, 0, width, height]);
    assert(
      user.symbols.AdjustWindowRect(
        ptr(rect),
        Number(user.symbols.GetWindowLongPtrW(window, -16)),
        0,
      ),
    );
    assert(
      user.symbols.SetWindowPos(
        window,
        0n,
        0,
        0,
        (rect[2] ?? 0) - (rect[0] ?? 0),
        (rect[3] ?? 0) - (rect[1] ?? 0),
        0x16,
      ),
    );
  }

  setPosition(window: bigint, x: number, y: number) {
    assert(user.symbols.SetWindowPos(window, 0n, x, y, 0, 0, 0x15));
  }

  isFullscreen(window: bigint) {
    return this.fullscreen.has(window);
  }

  setFullscreen(window: bigint, enabled: boolean) {
    if (enabled === this.isFullscreen(window)) return;
    if (enabled) {
      const placement = Buffer.alloc(44); // WINDOWPLACEMENT, Win64
      placement.writeUInt32LE(44);
      assert(user.symbols.GetWindowPlacement(window, ptr(placement)));
      const style = user.symbols.GetWindowLongPtrW(window, -16);
      const monitor = Buffer.alloc(40); // MONITORINFO
      monitor.writeUInt32LE(40);
      assert(user.symbols.GetMonitorInfoW(user.symbols.MonitorFromWindow(window, 2), ptr(monitor)));
      assert(user.symbols.SetWindowLongPtrW(window, -16, style & ~0xcf0000n));
      const x = monitor.readInt32LE(4),
        y = monitor.readInt32LE(8);
      assert(
        user.symbols.SetWindowPos(
          window,
          0n,
          x,
          y,
          monitor.readInt32LE(12) - x,
          monitor.readInt32LE(16) - y,
          0x34,
        ),
      );
      this.fullscreen.set(window, { style, placement });
    } else {
      const saved = this.fullscreen.get(window);
      assert(saved);
      assert(user.symbols.SetWindowLongPtrW(window, -16, saved.style));
      // GetWindowPlacement does not record whether the window is hidden.
      if (!(saved.style & 0x10000000n)) saved.placement.writeUInt32LE(0, 8); // SW_HIDE
      assert(user.symbols.SetWindowPlacement(window, ptr(saved.placement)));
      assert(user.symbols.SetWindowPos(window, 0n, 0, 0, 0, 0, 0x37));
      this.fullscreen.delete(window);
    }
  }

  confirmClose(window: bigint, title: string, message: string): boolean {
    const result = withWide(title, (caption) =>
      withWide(message, (text) => user.symbols.MessageBoxW(window, text, caption, 0x124)),
    );
    assert(result, `MessageBoxW: ${kernel.symbols.GetLastError()}`);
    return result === 6; // IDYES, default is No
  }

  destroy(window: bigint) {
    assert(user.symbols.DestroyWindow(window));
    this.windows.delete(window);
    this.fullscreen.delete(window);
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
