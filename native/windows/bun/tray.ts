import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import {
  MAX_TRAY_TOOLTIP_UNITS,
  type NativeMenuItem,
  type NativeTrayEvent,
  type NativeTraySnapshot,
} from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";
import { NativePopupMenu } from "./menu.ts";
import { createTrayIcon } from "./tray-icon.ts";
import { type Windows, WM_CLOSE } from "./win32.ts";
import { user, withWide } from "./win32-bindings.ts";

const TRAY_CALLBACK_MESSAGE = 0x8001;
const WM_NULL = 0x0000;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_LBUTTONDBLCLK = 0x0203;
const WM_RBUTTONUP = 0x0205;
const WM_RBUTTONDOWN = 0x0204;
const WM_RBUTTONDBLCLK = 0x0206;
const WM_MBUTTONDOWN = 0x0207;
const WM_MBUTTONUP = 0x0208;
const WM_MBUTTONDBLCLK = 0x0209;
const WM_CONTEXTMENU = 0x007b;
const NIM_ADD = 0;
const NIM_MODIFY = 1;
const NIM_DELETE = 2;
const NIM_SETFOCUS = 3;
const NIF_MESSAGE = 0x1;
const NIF_ICON = 0x2;
const NIF_TIP = 0x4;
const TPM_RIGHTBUTTON = 0x2;
const TPM_RETURNCMD = 0x100;
const TRAY_ICON_ID = 1;
const TRAY_TOOLTIP_BYTES = MAX_TRAY_TOOLTIP_UNITS * 2;
const NOTIFYICONIDENTIFIER_SIZE = 40;

const mouseNotifications: Readonly<
  Record<number, Pick<NativeTrayEvent, "button" | "state">>
> = {
  [WM_LBUTTONDOWN]: {
    button: "left",
    state: "down",
  },
  [WM_LBUTTONUP]: {
    button: "left",
    state: "up",
  },
  [WM_LBUTTONDBLCLK]: {
    button: "left",
    state: "double-click",
  },
  [WM_RBUTTONDOWN]: {
    button: "right",
    state: "down",
  },
  [WM_RBUTTONUP]: {
    button: "right",
    state: "up",
  },
  [WM_RBUTTONDBLCLK]: {
    button: "right",
    state: "double-click",
  },
  [WM_MBUTTONDOWN]: {
    button: "middle",
    state: "down",
  },
  [WM_MBUTTONUP]: {
    button: "middle",
    state: "up",
  },
  [WM_MBUTTONDBLCLK]: {
    button: "middle",
    state: "double-click",
  },
  [WM_CONTEXTMENU]: {
    button: "none",
    state: "context-menu",
  },
};

/** Owns the hidden window and shell icon used for app show and quit actions. */
export class Tray {
  private readonly shell;
  private readonly data = Buffer.alloc(976); // NOTIFYICONDATAW, Win64
  readonly hwnd: bigint;
  private added = false;
  private customMenu: readonly NativeMenuItem[] | null | undefined;
  private selected: ((itemId: string) => void) | undefined;
  private customIcon: bigint | undefined;
  private readonly retiredIcons = new Set<bigint>();
  private showOnLeftClick = true;
  private menuOnRightClick = true;
  private tooltip = "";
  private disposed = false;
  private windowDestroyed = false;
  private shellClosed = false;
  /** Registers the icon and releases partial resources if setup fails. */
  constructor(
    private readonly windows: Windows,
    tooltip: string,
    receive: (action: "show" | "quit") => void,
    notify?: (event: NativeTrayEvent) => void,
  ) {
    // Validate the whole startup value before acquiring this tray's native resources.
    if (/[\0\uD800-\uDFFF]/u.test(tooltip)) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Invalid tray tooltip.",
      });
    }
    this.shell = dlopen("shell32.dll", {
      Shell_NotifyIconW: {
        args: [
          "u32",
          "ptr",
        ],
        returns: "i32",
      },
      Shell_NotifyIconGetRect: {
        args: [
          "ptr",
          "ptr",
        ],
        returns: "i32",
      },
    });
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
          if (this.disposed) {
            return;
          }
          if (message === taskbarCreated) {
            // Explorer restarts clear notification icons, so add this one back.
            this.added = false;
            this.add();
          } else if (message === WM_CLOSE) {
            receive("quit");
          } else if (message === TRAY_CALLBACK_MESSAGE) {
            const input = mouseNotifications[Number(lparam)];
            if (input) {
              const point = new Int32Array(2);
              const available = user.symbols.GetCursorPos(ptr(point));
              notify?.({
                id: "main",
                ...input,
                position: available
                  ? {
                      x: point[0] ?? 0,
                      y: point[1] ?? 0,
                    }
                  : null,
              });
            }
            if (
              this.showOnLeftClick &&
              (Number(lparam) === WM_LBUTTONUP ||
                Number(lparam) === WM_LBUTTONDBLCLK)
            ) {
              receive("show");
            } else if (
              this.menuOnRightClick &&
              (Number(lparam) === WM_RBUTTONUP ||
                Number(lparam) === WM_CONTEXTMENU)
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
      // Preserve startup truncation while avoiding a split surrogate at the native WCHAR limit.
      for (const character of tooltip) {
        if (this.tooltip.length + character.length > MAX_TRAY_TOOLTIP_UNITS) {
          break;
        }
        this.tooltip += character;
      }
      Buffer.from(this.tooltip, "utf16le").copy(
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
  /** Return host-owned configuration, without claiming taskbar visibility or exposing image bytes. */
  get(): NativeTraySnapshot {
    return {
      id: "main",
      tooltip: this.tooltip,
      icon: this.customIcon === undefined ? "app" : "custom",
      showOnLeftClick: this.showOnLeftClick,
      menuOnRightClick: this.menuOnRightClick,
    };
  }
  /** Query physical shell coordinates. Overflow/unavailable shell bounds produce null. */
  getBounds() {
    const identifier = Buffer.alloc(NOTIFYICONIDENTIFIER_SIZE);
    identifier.writeUInt32LE(NOTIFYICONIDENTIFIER_SIZE, 0);
    identifier.writeBigUInt64LE(this.hwnd, 8);
    identifier.writeUInt32LE(TRAY_ICON_ID, 16);
    const rect = new Int32Array(4);
    if (
      this.shell.symbols.Shell_NotifyIconGetRect(ptr(identifier), ptr(rect)) < 0
    ) {
      return null;
    }
    return {
      x: rect[0] ?? 0,
      y: rect[1] ?? 0,
      width: (rect[2] ?? 0) - (rect[0] ?? 0),
      height: (rect[3] ?? 0) - (rect[1] ?? 0),
    };
  }
  /** Commit a tooltip update only if the shell accepts the new NOTIFYICONDATAW. */
  setTooltip(tooltip: string) {
    if (
      tooltip.length > MAX_TRAY_TOOLTIP_UNITS ||
      /[\0\uD800-\uDFFF]/u.test(tooltip)
    ) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Invalid tray tooltip.",
      });
    }
    const old = Buffer.from(this.data);
    this.data.fill(0, 40, 40 + TRAY_TOOLTIP_BYTES + 2);
    Buffer.from(tooltip, "utf16le").copy(this.data, 40);
    if (!this.shell.symbols.Shell_NotifyIconW(NIM_MODIFY, ptr(this.data))) {
      old.copy(this.data);
      throw new BunawayError({
        code: "INTERNAL",
        message: "Tray tooltip update failed.",
      });
    }
    this.tooltip = tooltip;
  }
  /** Own a new ICO handle until successful replacement or disposal; null restores the app icon. */
  setIcon(ico: string | null) {
    const next = ico === null ? this.windows.icon : createTrayIcon(ico);
    assert(next, "App tray icon unavailable.");
    const previous = this.data.readBigUInt64LE(32);
    this.data.writeBigUInt64LE(next, 32);
    if (!this.shell.symbols.Shell_NotifyIconW(NIM_MODIFY, ptr(this.data))) {
      this.data.writeBigUInt64LE(previous, 32);
      if (ico !== null && !user.symbols.DestroyIcon(next)) {
        this.retiredIcons.add(next);
      }
      throw new BunawayError({
        code: "INTERNAL",
        message: "Tray icon update failed.",
      });
    }
    const owned = this.customIcon;
    this.customIcon = ico === null ? undefined : next;
    if (owned && !user.symbols.DestroyIcon(owned)) {
      this.retiredIcons.add(owned);
      throw new Error("Tray icon cleanup failed.");
    }
  }
  /** Change native click defaults; notifications continue for every recognized mouse message. */
  setClickBehavior(showOnLeftClick: boolean, menuOnRightClick: boolean) {
    this.showOnLeftClick = showOnLeftClick;
    this.menuOnRightClick = menuOnRightClick;
  }
  /** Ask the shell to focus this configured tray icon. OS refusal returns false. */
  focus(): boolean {
    return (
      this.shell.symbols.Shell_NotifyIconW(NIM_SETFOCUS, ptr(this.data)) !== 0
    );
  }
  /**
   * Stop callbacks and release owned resources, retaining failed releases for a later attempt.
   */
  dispose() {
    this.disposed = true;
    const errors: unknown[] = [];
    try {
      if (this.added) {
        this.shell.symbols.Shell_NotifyIconW(NIM_DELETE, ptr(this.data));
      }
      this.added = false;
    } catch (error) {
      errors.push(error);
    }
    if (!this.windowDestroyed) {
      try {
        this.windows.destroy(this.hwnd);
        this.windowDestroyed = true;
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.customIcon) {
      this.retiredIcons.add(this.customIcon);
      this.customIcon = undefined;
    }
    for (const icon of this.retiredIcons) {
      try {
        assert(user.symbols.DestroyIcon(icon), "Tray icon cleanup failed.");
        this.retiredIcons.delete(icon);
      } catch (error) {
        errors.push(error);
      }
    }
    if (!this.shellClosed && !this.added && this.windowDestroyed) {
      try {
        this.shell.close();
        this.shellClosed = true;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "Tray resource cleanup failed.");
    }
  }
}
