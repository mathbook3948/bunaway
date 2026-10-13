import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import type { NativeMenuItem } from "@bunaway/plugin-api/native";
import { NativePopupMenu } from "./menu.ts";
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
const TPM_RIGHTBUTTON = 0x2;
const TPM_RETURNCMD = 0x100;
const TRAY_ICON_ID = 1;
const TRAY_TOOLTIP_BYTES = 254;

/** Owns the hidden window and shell icon used for app show and quit actions. */
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
  private customMenu: readonly NativeMenuItem[] | null | undefined;
  private selected: ((itemId: string) => void) | undefined;
  /** Registers the icon and releases partial resources if setup fails. */
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
            // Explorer restarts clear notification icons, so add this one back.
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
    if (this.customMenu === null) {
      return;
    }
    const selected = this.selected;
    const custom = this.customMenu !== undefined;
    const menu = new NativePopupMenu(
      this.customMenu ?? [
        {
          id: "open",
          type: "item",
          label: "Open",
          enabled: true,
          visible: true,
          checked: false,
          group: null,
        },
        {
          id: "quit",
          type: "item",
          label: "Quit",
          enabled: true,
          visible: true,
          checked: false,
          group: null,
        },
      ],
    );
    try {
      const point = new Int32Array(2);
      assert(user.symbols.GetCursorPos(ptr(point)));
      user.symbols.SetForegroundWindow(this.hwnd);
      const item = user.symbols.TrackPopupMenuEx(
        menu.handle,
        TPM_RETURNCMD | TPM_RIGHTBUTTON,
        point[0] ?? 0,
        point[1] ?? 0,
        this.hwnd,
        null,
      );
      user.symbols.PostMessageW(this.hwnd, WM_NULL, 0n, 0n);
      const itemId = menu.selected(item);
      if (custom && itemId !== null) {
        selected?.(itemId);
      } else if (!custom && itemId === "open") {
        receive("show");
      } else if (!custom && itemId === "quit") {
        receive("quit");
      }
    } finally {
      menu.dispose();
    }
  }
  /** Replace the next popup's definition without touching the shell icon or owner HWND. */
  setMenu(
    items: readonly NativeMenuItem[] | null | undefined,
    selected?: (itemId: string) => void,
  ) {
    this.customMenu =
      items === undefined || items === null ? items : structuredClone(items);
    this.selected = selected;
  }
  /**
   * Requests shell icon removal when registered, destroys its window, and closes the shell binding.
   */
  dispose() {
    if (this.added) {
      this.shell.symbols.Shell_NotifyIconW(NIM_DELETE, ptr(this.data));
    }
    this.added = false;
    this.windows.destroy(this.hwnd);
    this.shell.close();
  }
}
