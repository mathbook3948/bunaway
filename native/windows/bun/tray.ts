import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { user, type Windows, withWide } from "./win32.ts";

const CALLBACK = 0x8001;
export class Tray {
  private readonly shell = dlopen("shell32.dll", {
    Shell_NotifyIconW: { args: ["u32", "ptr"], returns: "i32" },
  });
  private readonly data = Buffer.alloc(976); // NOTIFYICONDATAW, Win64
  readonly hwnd: bigint;
  private added = false;
  constructor(
    private readonly windows: Windows,
    tooltip: string,
    receive: (action: "show" | "quit") => void,
  ) {
    const taskbarCreated = withWide("TaskbarCreated", (name) =>
      user.symbols.RegisterWindowMessageW(name),
    );
    if (!taskbarCreated) {
      this.shell.close();
      throw new Error("TaskbarCreated registration failed");
    }
    try {
      this.hwnd = windows.create(
        tooltip,
        200,
        200,
        (message, _wparam, lparam) => {
          if (message === taskbarCreated) {
            this.added = false;
            this.add();
          } else if (message === 0x10) receive("quit");
          else if (message === CALLBACK) {
            if (Number(lparam) === 0x202 || Number(lparam) === 0x203) receive("show");
            else if (Number(lparam) === 0x205 || Number(lparam) === 0x7b) this.menu(receive);
          }
        },
        false,
      );
    } catch (error) {
      this.shell.close();
      throw error;
    }
    try {
      this.data.writeUInt32LE(this.data.length, 0);
      this.data.writeBigUInt64LE(this.hwnd, 8);
      this.data.writeUInt32LE(1, 16);
      this.data.writeUInt32LE(7, 20); // NIF_MESSAGE | NIF_ICON | NIF_TIP
      this.data.writeUInt32LE(CALLBACK, 24);
      const icon = user.symbols.LoadIconW(0n, 32512n); // shared IDI_APPLICATION
      assert(icon, "Tray icon unavailable");
      this.data.writeBigUInt64LE(icon, 32);
      Buffer.from(tooltip, "utf16le").copy(this.data, 40, 0, 254);
      this.add();
    } catch (error) {
      windows.destroy(this.hwnd);
      this.shell.close();
      throw error;
    }
  }

  private add() {
    assert(this.shell.symbols.Shell_NotifyIconW(0, ptr(this.data)), "Tray creation failed");
    this.added = true;
  }
  private menu(receive: (action: "show" | "quit") => void) {
    const menu = user.symbols.CreatePopupMenu();
    assert(menu, "Tray menu creation failed");
    try {
      assert(withWide("Open", (text) => user.symbols.AppendMenuW(menu, 0, 1n, text)));
      assert(withWide("Quit", (text) => user.symbols.AppendMenuW(menu, 0, 2n, text)));
      const point = new Int32Array(2);
      assert(user.symbols.GetCursorPos(ptr(point)));
      user.symbols.SetForegroundWindow(this.hwnd);
      const item = user.symbols.TrackPopupMenuEx(
        menu,
        0x102,
        point[0] ?? 0,
        point[1] ?? 0,
        this.hwnd,
        null,
      );
      user.symbols.PostMessageW(this.hwnd, 0, 0n, 0n);
      if (item === 1) receive("show");
      else if (item === 2) receive("quit");
    } finally {
      assert(user.symbols.DestroyMenu(menu));
    }
  }
  dispose() {
    if (this.added) this.shell.symbols.Shell_NotifyIconW(2, ptr(this.data));
    this.added = false;
    this.windows.destroy(this.hwnd);
    this.shell.close();
  }
}
