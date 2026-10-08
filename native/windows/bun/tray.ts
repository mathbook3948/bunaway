import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { type Windows, WM_CLOSE } from "./win32.ts";
import { user, withWide } from "./win32-bindings.ts";

const TRAY_CALLBACK_MESSAGE = 0x8001;
const WM_NULL = 0x0000;
const WM_LBUTTONUP = 0x0202;
const WM_LBUTTONDBLCLK = 0x0203;
const WM_RBUTTONUP = 0x0205;
const WM_CONTEXTMENU = 0x007b;
const NIM_ADD = 0;
const NIM_DELETE = 2;
const NIF_MESSAGE = 0x1;
const NIF_ICON = 0x2;
const NIF_TIP = 0x4;
const MF_STRING = 0;
const TPM_RIGHTBUTTON = 0x2;
const TPM_RETURNCMD = 0x100;
const TRAY_ICON_ID = 1;
const TRAY_OPEN_COMMAND = 1;
const TRAY_QUIT_COMMAND = 2;
const TRAY_TOOLTIP_BYTES = 254;
export class Tray {
  private readonly shell = dlopen("shell32.dll", {
    Shell_NotifyIconW: {
      args: [
        "u32",
        "ptr",
      ],
      returns: "i32",
    },
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
          } else if (message === WM_CLOSE) {
            receive("quit");
          } else if (message === TRAY_CALLBACK_MESSAGE) {
            if (
              Number(lparam) === WM_LBUTTONUP ||
              Number(lparam) === WM_LBUTTONDBLCLK
            ) {
              receive("show");
            } else if (
              Number(lparam) === WM_RBUTTONUP ||
              Number(lparam) === WM_CONTEXTMENU
            ) {
              this.menu(receive);
            }
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
      this.data.writeUInt32LE(TRAY_ICON_ID, 16);
      this.data.writeUInt32LE(NIF_MESSAGE | NIF_ICON | NIF_TIP, 20);
      this.data.writeUInt32LE(TRAY_CALLBACK_MESSAGE, 24);
      const icon = windows.icon;
      assert(icon, "Tray icon unavailable");
      this.data.writeBigUInt64LE(icon, 32);
      Buffer.from(tooltip, "utf16le").copy(
        this.data,
        40,
        0,
        TRAY_TOOLTIP_BYTES,
      );
      this.add();
    } catch (error) {
      windows.destroy(this.hwnd);
      this.shell.close();
      throw error;
    }
  }

  private add() {
    assert(
      this.shell.symbols.Shell_NotifyIconW(NIM_ADD, ptr(this.data)),
      "Tray creation failed",
    );
    this.added = true;
  }
  private menu(receive: (action: "show" | "quit") => void) {
    const menu = user.symbols.CreatePopupMenu();
    assert(menu, "Tray menu creation failed");
    try {
      assert(
        withWide("Open", (text) =>
          user.symbols.AppendMenuW(
            menu,
            MF_STRING,
            BigInt(TRAY_OPEN_COMMAND),
            text,
          ),
        ),
      );
      assert(
        withWide("Quit", (text) =>
          user.symbols.AppendMenuW(
            menu,
            MF_STRING,
            BigInt(TRAY_QUIT_COMMAND),
            text,
          ),
        ),
      );
      const point = new Int32Array(2);
      assert(user.symbols.GetCursorPos(ptr(point)));
      user.symbols.SetForegroundWindow(this.hwnd);
      const item = user.symbols.TrackPopupMenuEx(
        menu,
        TPM_RETURNCMD | TPM_RIGHTBUTTON,
        point[0] ?? 0,
        point[1] ?? 0,
        this.hwnd,
        null,
      );
      user.symbols.PostMessageW(this.hwnd, WM_NULL, 0n, 0n);
      if (item === TRAY_OPEN_COMMAND) {
        receive("show");
      } else if (item === TRAY_QUIT_COMMAND) {
        receive("quit");
      }
    } finally {
      assert(user.symbols.DestroyMenu(menu));
    }
  }
  dispose() {
    if (this.added) {
      this.shell.symbols.Shell_NotifyIconW(NIM_DELETE, ptr(this.data));
    }
    this.added = false;
    this.windows.destroy(this.hwnd);
    this.shell.close();
  }
}
