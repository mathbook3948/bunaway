import { dlopen, JSCallback, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import {
  APP_SHUTDOWN_MESSAGE,
  APP_WINDOW_CLASS_PREFIX,
} from "../../../packages/runtime-bun/src/windows-control.ts";
import { hr, kernel, user, wide, withWide } from "./win32-bindings.ts";

export const WM_SIZE = 0x0005;
export const WM_CLOSE = 0x0010;
export const WM_QUIT = 0x0012;
export const WM_ENTERSIZEMOVE = 0x0231;
export const WM_EXITSIZEMOVE = 0x0232;

const COLOR_WINDOW = 5;
const CW_USEDEFAULT = -2147483648;
const GWL_STYLE = -16;
const IDI_APPLICATION = 32512n;
const IMAGE_ICON = 1;
const LR_LOADFROMFILE = 0x10;
const MB_DEFBUTTON2 = 0x100;
const MB_ICONQUESTION = 0x20;
const MB_YESNO = 0x4;
const MONITOR_DEFAULTTONEAREST = 2;
const PM_REMOVE = 1;
const SW_HIDE = 0;
const SW_RESTORE = 9;
const SW_SHOW = 5;
const SWP_FRAMECHANGED = 0x20;
const SWP_NOMOVE = 0x2;
const SWP_NOACTIVATE = 0x10;
const SWP_NOSIZE = 0x1;
const SWP_NOZORDER = 0x4;
const WINDOWPLACEMENT_SHOW_CMD_OFFSET = 8;
const WS_OVERLAPPEDWINDOW = 0x00cf0000;
const WS_VISIBLE = 0x10000000n;
const IDYES = 6;
const MAX_MESSAGES_PER_PUMP = 64;

// One class and one bounded pump per STA, shared by every view.
export class Windows {
  readonly thread = kernel.symbols.GetCurrentThreadId();
  private readonly instance = kernel.symbols.GetModuleHandleW(null);
  private readonly name = wide(
    `${APP_WINDOW_CLASS_PREFIX}${process.pid}-${this.thread}`,
  );
  private readonly message = Buffer.alloc(48); // MSG, Win64
  private readonly windows = new Map<
    bigint,
    (message: number, wparam: bigint, lparam: bigint) => void
  >();
  private readonly callback: JSCallback;
  private readonly fullscreen = new Map<
    bigint,
    {
      style: bigint;
      placement: Buffer;
    }
  >();
  private registered = false;
  failure: unknown;
  readonly icon: bigint;
  private readonly smallIcon: bigint;
  private readonly ownedIcons: boolean;

  constructor(shutdown: () => void, iconPath?: string, appId?: string) {
    if (appId) {
      const shell = dlopen("shell32.dll", {
        SetCurrentProcessExplicitAppUserModelID: {
          args: [
            "ptr",
          ],
          returns: "i32",
        },
      });
      try {
        hr(
          withWide(appId, (id) =>
            shell.symbols.SetCurrentProcessExplicitAppUserModelID(id),
          ),
          "AppUserModelID",
        );
      } finally {
        shell.close();
      }
    }
    this.ownedIcons = !!iconPath;
    if (iconPath?.toLowerCase().endsWith(".exe")) {
      const shell = dlopen("shell32.dll", {
        ExtractIconExW: {
          args: [
            "ptr",
            "i32",
            "ptr",
            "ptr",
            "u32",
          ],
          returns: "u32",
        },
      });
      const large = new BigUint64Array(1);
      const small = new BigUint64Array(1);
      try {
        withWide(iconPath, (path) =>
          shell.symbols.ExtractIconExW(path, 0, ptr(large), ptr(small), 1),
        );
        this.icon = large[0] ?? 0n;
        this.smallIcon = small[0] ?? 0n;
      } finally {
        shell.close();
      }
    } else {
      this.icon = iconPath
        ? withWide(iconPath, (path) =>
            user.symbols.LoadImageW(
              0n,
              path,
              IMAGE_ICON,
              32,
              32,
              LR_LOADFROMFILE,
            ),
          )
        : user.symbols.LoadIconW(0n, IDI_APPLICATION);
      this.smallIcon = iconPath
        ? withWide(iconPath, (path) =>
            user.symbols.LoadImageW(
              0n,
              path,
              IMAGE_ICON,
              16,
              16,
              LR_LOADFROMFILE,
            ),
          )
        : this.icon;
    }
    if (!this.icon || !this.smallIcon) {
      this.releaseIcons();
      throw new Error("App icon could not be loaded.");
    }
    this.callback = new JSCallback(
      (window: bigint, message: number, wparam: bigint, lparam: bigint) => {
        try {
          assert.equal(kernel.symbols.GetCurrentThreadId(), this.thread);
          if (message === APP_SHUTDOWN_MESSAGE) {
            shutdown();
            return 0n;
          }
          this.windows.get(window)?.(message, wparam, lparam);
          if (message === WM_CLOSE) {
            return 0n; // defer Close/DestroyWindow past callback
          }
          return user.symbols.DefWindowProcW(window, message, wparam, lparam);
        } catch (error) {
          this.failure ??= error;
          return 0n;
        }
      },
      {
        args: [
          "u64",
          "u32",
          "u64",
          "i64",
        ],
        returns: "i64",
      },
    );
    const wc = Buffer.alloc(80); // WNDCLASSEXW, Win64
    wc.writeUInt32LE(80, 0);
    wc.writeBigUInt64LE(BigInt(this.callback.ptr ?? 0), 8);
    wc.writeBigUInt64LE(this.instance, 24);
    wc.writeBigUInt64LE(this.icon, 32);
    wc.writeBigUInt64LE(BigInt(COLOR_WINDOW + 1), 48);
    wc.writeBigUInt64LE(BigInt(ptr(this.name)), 64);
    wc.writeBigUInt64LE(this.smallIcon, 72);
    if (!user.symbols.RegisterClassExW(ptr(wc))) {
      this.callback.close();
      this.releaseIcons();
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
    const rect = new Int32Array([
      0,
      0,
      width,
      height,
    ]);
    assert(user.symbols.AdjustWindowRect(ptr(rect), WS_OVERLAPPEDWINDOW, 0));
    const window = withWide(title, (titlePointer) =>
      user.symbols.CreateWindowExW(
        0,
        ptr(this.name),
        titlePointer,
        WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT,
        CW_USEDEFAULT,
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
    if (visible) {
      user.symbols.ShowWindow(window, SW_SHOW);
    }
    return window;
  }

  show(window: bigint, visible: boolean) {
    user.symbols.ShowWindow(window, visible ? SW_SHOW : SW_HIDE);
  }

  focus(window: bigint): boolean {
    user.symbols.ShowWindow(
      window,
      user.symbols.IsIconic(window) ? SW_RESTORE : SW_SHOW,
    );
    return !!user.symbols.SetForegroundWindow(window);
  }

  setSize(window: bigint, width: number, height: number) {
    const rect = new Int32Array([
      0,
      0,
      width,
      height,
    ]);
    assert(
      user.symbols.AdjustWindowRect(
        ptr(rect),
        Number(user.symbols.GetWindowLongPtrW(window, GWL_STYLE)),
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
        SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
      ),
    );
  }

  setPosition(window: bigint, x: number, y: number) {
    assert(
      user.symbols.SetWindowPos(
        window,
        0n,
        x,
        y,
        0,
        0,
        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
      ),
    );
  }

  isFullscreen(window: bigint) {
    return this.fullscreen.has(window);
  }

  setFullscreen(window: bigint, enabled: boolean) {
    if (enabled === this.isFullscreen(window)) {
      return;
    }
    if (enabled) {
      const placement = Buffer.alloc(44); // WINDOWPLACEMENT, Win64
      placement.writeUInt32LE(44);
      assert(user.symbols.GetWindowPlacement(window, ptr(placement)));
      const style = user.symbols.GetWindowLongPtrW(window, GWL_STYLE);
      const monitor = Buffer.alloc(40); // MONITORINFO
      monitor.writeUInt32LE(40);
      assert(
        user.symbols.GetMonitorInfoW(
          user.symbols.MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST),
          ptr(monitor),
        ),
      );
      assert(
        user.symbols.SetWindowLongPtrW(
          window,
          GWL_STYLE,
          style & ~BigInt(WS_OVERLAPPEDWINDOW),
        ),
      );
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
          SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        ),
      );
      this.fullscreen.set(window, {
        style,
        placement,
      });
    } else {
      const saved = this.fullscreen.get(window);
      assert(saved);
      assert(user.symbols.SetWindowLongPtrW(window, GWL_STYLE, saved.style));
      // GetWindowPlacement does not record whether the window is hidden.
      if (!(saved.style & WS_VISIBLE)) {
        saved.placement.writeUInt32LE(SW_HIDE, WINDOWPLACEMENT_SHOW_CMD_OFFSET);
      }
      assert(user.symbols.SetWindowPlacement(window, ptr(saved.placement)));
      assert(
        user.symbols.SetWindowPos(
          window,
          0n,
          0,
          0,
          0,
          0,
          SWP_NOSIZE |
            SWP_NOMOVE |
            SWP_NOZORDER |
            SWP_NOACTIVATE |
            SWP_FRAMECHANGED,
        ),
      );
      this.fullscreen.delete(window);
    }
  }

  confirmClose(window: bigint, title: string, message: string): boolean {
    const result = withWide(title, (caption) =>
      withWide(message, (text) =>
        user.symbols.MessageBoxW(
          window,
          text,
          caption,
          MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2,
        ),
      ),
    );
    assert(result, `MessageBoxW: ${kernel.symbols.GetLastError()}`);
    return result === IDYES;
  }

  destroy(window: bigint) {
    assert(user.symbols.DestroyWindow(window));
    this.windows.delete(window);
    this.fullscreen.delete(window);
  }

  pump() {
    for (
      let count = 0;
      count < MAX_MESSAGES_PER_PUMP &&
      user.symbols.PeekMessageW(ptr(this.message), 0n, 0, 0, PM_REMOVE);
      count++
    ) {
      if (this.message.readUInt32LE(8) === WM_QUIT) {
        throw new Error("Unexpected WM_QUIT");
      }
      user.symbols.TranslateMessage(ptr(this.message));
      user.symbols.DispatchMessageW(ptr(this.message));
    }
    if (this.failure) {
      throw this.failure;
    }
  }

  private releaseIcons() {
    if (this.ownedIcons) {
      if (this.icon) {
        user.symbols.DestroyIcon(this.icon);
      }
      if (this.smallIcon) {
        user.symbols.DestroyIcon(this.smallIcon);
      }
    }
  }

  dispose() {
    assert.equal(this.windows.size, 0);
    if (this.registered) {
      assert(user.symbols.UnregisterClassW(ptr(this.name), this.instance));
    }
    this.registered = false;
    this.callback.close();
    this.releaseIcons();
  }
}
