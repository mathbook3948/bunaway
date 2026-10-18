import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { failWithCleanup } from "@bunaway/plugin";
import { withWide } from "@bunaway/plugin/win32";
import {
  MAX_TRAY_TOOLTIP_UNITS,
  type NativeMenuItem,
  type NativeTrayEvent,
  type NativeTrayOwner,
  type NativeTraySnapshot,
  type NativeTrayWindowHost,
} from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";
import { openTrayBindings } from "#tray/platforms/windows-bindings";
import { createTrayIcon } from "#tray/platforms/windows-icon";
import { NativePopupMenu } from "#tray/platforms/windows-popup-menu";
import {
  type TrayHoverEvent,
  TrayHoverTracker,
} from "#tray/platforms/windows-tray-hover";

const WM_CLOSE = 0x0010;

const TRAY_CALLBACK_MESSAGE = 0x8001;
const WM_NULL = 0x0000;
const WM_TIMER = 0x0113;
const WM_MOUSEMOVE = 0x0200;
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
const NIF_STATE = 0x8;
const NIS_HIDDEN = 0x1;
// NOTIFYICONDATAW offsets after szTip (Win64).
const DW_STATE_OFFSET = 296;
const DW_STATE_MASK_OFFSET = 300;
const TPM_RIGHTBUTTON = 0x2;
const TPM_RETURNCMD = 0x100;
const TRAY_ICON_ID = 1;
// A native menu loop only reaches the host's cancellation packets through window messages.
const POPUP_TIMER_ID = 0xb171;
const POPUP_POLL_INTERVAL_MS = 50;
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
  private readonly user;
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
  private visible = true;
  private disposed = false;
  private windowDestroyed = false;
  private shellClosed = false;
  private userClosed = false;
  /** A native menu loop owns the UI thread; a second one must not nest inside it. */
  private popupActive = false;
  /** Set when a cancellation arrives, possibly before the loop has started tracking. */
  private popupCancelled = false;
  private readonly hover: TrayHoverTracker;
  /** Registers the icon and releases partial resources if setup fails. */
  constructor(
    private readonly windows: NativeTrayWindowHost,
    tooltip: string,
    receive: (action: "show" | "quit") => void,
    notify?: (event: NativeTrayEvent) => void,
    retain?: (owner: NativeTrayOwner) => void,
    notifyHover?: (event: TrayHoverEvent) => void,
  ) {
    // Validate the whole startup value before acquiring this tray's native resources.
    if (/[\0\uD800-\uDFFF]/u.test(tooltip)) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Invalid tray tooltip.",
      });
    }
    this.user = openTrayBindings();
    this.hover = new TrayHoverTracker({
      now: () => performance.now(),
      cursor: () => this.cursorPosition(),
      bounds: () => this.getBounds(),
      emit: (event) => notifyHover?.(event),
      fail: (error) => console.error("Tray hover tracking stopped:", error),
      startPolling: (poll, intervalMs) => {
        const timer = setInterval(poll, intervalMs);
        // The leave poll must not keep the process alive by itself.
        timer.unref();
        return () => clearInterval(timer);
      },
    });
    try {
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
    } catch (error) {
      this.user.close();
      throw error;
    }
    const taskbarCreated = withWide("TaskbarCreated", (name) =>
      this.user.symbols.RegisterWindowMessageW(name),
    );
    if (!taskbarCreated) {
      this.shell.close();
      this.user.close();
      throw new Error("TaskbarCreated registration failed");
    }
    try {
      this.hwnd = windows.create(
        tooltip,
        200,
        200,
        (message, wparam, lparam) => {
          if (this.disposed) {
            return;
          }
          if (message === taskbarCreated) {
            // Explorer restarts clear notification icons, so add this one back.
            this.added = false;
            this.add();
          } else if (message === WM_TIMER) {
            this.retryPopupCancel(wparam);
          } else if (message === WM_CLOSE) {
            receive("quit");
          } else if (message === TRAY_CALLBACK_MESSAGE) {
            this.handleShellNotification(Number(lparam), receive, notify);
          }
        },
        false,
      );
    } catch (error) {
      this.shell.close();
      this.user.close();
      throw error;
    }
    // Retain the resource before shell registration so a failed startup release remains retryable.
    retain?.(this);
    try {
      this.data.writeUInt32LE(this.data.length, 0);
      this.data.writeBigUInt64LE(this.hwnd, 8);
      this.data.writeUInt32LE(TRAY_ICON_ID, 16);
      this.data.writeUInt32LE(NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_STATE, 20);
      // Only the hidden bit is ever claimed, so every NIM_MODIFY and Explorer re-add keeps it.
      this.data.writeUInt32LE(NIS_HIDDEN, DW_STATE_MASK_OFFSET);
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
      failWithCleanup(
        error,
        () => this.dispose(),
        "Tray initialization cleanup failed.",
      );
    }
  }

  /** Physical pointer position, or null when the OS refuses the query. */
  private cursorPosition() {
    const point = new Int32Array(2);
    return this.user.symbols.GetCursorPos(ptr(point))
      ? {
          x: point[0] ?? 0,
          y: point[1] ?? 0,
        }
      : null;
  }

  private add() {
    assert(
      this.shell.symbols.Shell_NotifyIconW(NIM_ADD, ptr(this.data)),
      "Tray creation failed",
    );
    this.added = true;
  }
  /** Reports one shell mouse notification, then applies the click behavior defaults. */
  private handleShellNotification(
    notification: number,
    receive: (action: "show" | "quit") => void,
    notify: ((event: NativeTrayEvent) => void) | undefined,
  ) {
    const input = mouseNotifications[notification];
    if (notification === WM_MOUSEMOVE) {
      this.hover.mouseMoved();
    } else if (input) {
      notify?.({
        id: "main",
        ...input,
        position: this.cursorPosition(),
      });
    }
    if (
      this.showOnLeftClick &&
      (notification === WM_LBUTTONUP || notification === WM_LBUTTONDBLCLK)
    ) {
      receive("show");
    } else if (
      this.menuOnRightClick &&
      (notification === WM_RBUTTONUP || notification === WM_CONTEXTMENU)
    ) {
      this.menu(receive);
    }
  }
  /**
   * EndMenu can run before TrackPopupMenuEx starts tracking, so the popup timer repeats it
   * until Windows is inside its modal loop and the cancelled popup closes.
   */
  private retryPopupCancel(timerId: bigint) {
    if (timerId === BigInt(POPUP_TIMER_ID) && this.popupCancelled) {
      this.user.symbols.EndMenu();
    }
  }
  /** Right-click popup at the pointer. A popup that is already open absorbs the click. */
  private menu(receive: (action: "show" | "quit") => void) {
    if (this.customMenu === null || this.popupActive) {
      return;
    }
    this.track(null, receive);
  }
  /**
   * Opens the attached menu at `position` (the pointer when null) and blocks until a choice,
   * dismissal or `signal` abort. The choice reaches the attachment's callback, as with a
   * right-click. Without an attached menu the host's Open/Quit menu is not a popup target.
   */
  popUpContextMenu(
    position: {
      x: number;
      y: number;
    } | null,
    signal: AbortSignal,
  ) {
    if (this.disposed) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "The tray was released.",
      });
    }
    if (!this.windows.interrupt) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "This host cannot interrupt a tray menu.",
      });
    }
    if (!this.customMenu) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "No menu is attached to the tray.",
      });
    }
    if (this.popupActive) {
      throw new BunawayError({
        code: "BUSY",
        message: "A tray menu is already open.",
      });
    }
    this.track(position, () => {}, signal);
  }
  /**
   * Shows the popup and reports the choice. `signal` cancellation ends the native loop and
   * throws CANCELLED without reporting a choice.
   */
  private track(
    position: {
      x: number;
      y: number;
    } | null,
    receive: (action: "show" | "quit") => void,
    signal?: AbortSignal,
  ) {
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
    const cancel = () => {
      this.popupCancelled = true;
      this.user.symbols.EndMenu();
    };
    let stopInterrupt: (() => void) | undefined;
    let timerStarted = false;
    this.popupActive = true;
    this.popupCancelled = false;
    try {
      const point = position ?? this.cursorPosition();
      assert(point, "Tray popup position unavailable.");
      if (signal) {
        stopInterrupt = this.windows.interrupt?.(signal, cancel);
        signal.addEventListener("abort", cancel, {
          once: true,
        });
        timerStarted = !!this.user.symbols.SetTimer(
          this.hwnd,
          BigInt(POPUP_TIMER_ID),
          POPUP_POLL_INTERVAL_MS,
          null,
        );
        assert(timerStarted, "Tray popup cancellation timer failed.");
        if (signal.aborted) {
          this.popupCancelled = true;
        }
      }
      let item = 0;
      if (!this.popupCancelled) {
        // The owner must be foreground, or the popup would not close on an outside click.
        this.user.symbols.SetForegroundWindow(this.hwnd);
        try {
          item = this.user.symbols.TrackPopupMenuEx(
            menu.handle,
            TPM_RETURNCMD | TPM_RIGHTBUTTON,
            point.x,
            point.y,
            this.hwnd,
            null,
          );
        } finally {
          // Lets the menu loop settle so the next click reaches the previous foreground app.
          this.user.symbols.PostMessageW(this.hwnd, WM_NULL, 0n, 0n);
        }
      }
      if (this.popupCancelled) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Tray menu cancelled.",
        });
      }
      const itemId = menu.selected(item);
      if (custom && itemId !== null) {
        selected?.(itemId);
      } else if (!custom && itemId === "open") {
        receive("show");
      } else if (!custom && itemId === "quit") {
        receive("quit");
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
      stopInterrupt?.();
      if (timerStarted) {
        this.user.symbols.KillTimer(this.hwnd, BigInt(POPUP_TIMER_ID));
      }
      this.popupCancelled = false;
      this.popupActive = false;
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
      visible: this.visible,
    };
  }
  /** Query physical shell coordinates. A hidden icon, overflow or unavailable shell bounds produce null. */
  getBounds() {
    if (!this.visible) {
      return null;
    }
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
      if (ico !== null && !this.user.symbols.DestroyIcon(next)) {
        this.retiredIcons.add(next);
      }
      throw new BunawayError({
        code: "INTERNAL",
        message: "Tray icon update failed.",
      });
    }
    const owned = this.customIcon;
    this.customIcon = ico === null ? undefined : next;
    if (owned && !this.user.symbols.DestroyIcon(owned)) {
      this.retiredIcons.add(owned);
      throw new Error("Tray icon cleanup failed.");
    }
  }
  /** Change native click defaults; notifications continue for every recognized mouse message. */
  setClickBehavior(showOnLeftClick: boolean, menuOnRightClick: boolean) {
    this.showOnLeftClick = showOnLeftClick;
    this.menuOnRightClick = menuOnRightClick;
  }
  /**
   * Hide or show the icon with NIS_HIDDEN. The registration, tooltip, icon and menu stay in place,
   * so the icon returns as it was and the app keeps its configured residency. The state is committed
   * only if the shell accepts it.
   */
  setVisible(visible: boolean) {
    const previous = this.data.readUInt32LE(DW_STATE_OFFSET);
    this.data.writeUInt32LE(visible ? 0 : NIS_HIDDEN, DW_STATE_OFFSET);
    if (!this.shell.symbols.Shell_NotifyIconW(NIM_MODIFY, ptr(this.data))) {
      this.data.writeUInt32LE(previous, DW_STATE_OFFSET);
      throw new BunawayError({
        code: "INTERNAL",
        message: "Tray visibility update failed.",
      });
    }
    this.visible = visible;
  }
  /** Ask the shell to focus this configured tray icon. A hidden icon or OS refusal returns false. */
  focus(): boolean {
    if (!this.visible) {
      return false;
    }
    return (
      this.shell.symbols.Shell_NotifyIconW(NIM_SETFOCUS, ptr(this.data)) !== 0
    );
  }
  /**
   * Stop callbacks and release owned resources, retaining failed releases for a later attempt.
   */
  dispose() {
    this.disposed = true;
    this.hover.dispose();
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
        assert(
          this.user.symbols.DestroyIcon(icon),
          "Tray icon cleanup failed.",
        );
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
    if (this.shellClosed && this.retiredIcons.size === 0 && !this.userClosed) {
      try {
        this.user.close();
        this.userClosed = true;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "Tray resource cleanup failed.");
    }
  }
}
