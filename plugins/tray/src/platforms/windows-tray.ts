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
import {
  MAX_TRAY_BALLOON_CONTENT_UNITS,
  MAX_TRAY_BALLOON_TITLE_UNITS,
  type TrayBalloon,
} from "#tray/contract";
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
const NIF_INFO = 0x10;
const NIS_HIDDEN = 0x1;
const NIIF_INFO = 0x1;
const NIIF_WARNING = 0x2;
const NIIF_ERROR = 0x3;
const NIIF_NOSOUND = 0x10;
// Balloon notifications arrive in the callback message's lParam (WM_USER + 2 to 5).
const NIN_BALLOONSHOW = 0x402;
const NIN_BALLOONHIDE = 0x403;
const NIN_BALLOONTIMEOUT = 0x404;
const NIN_BALLOONUSERCLICK = 0x405;
// NOTIFYICONDATAW offsets after szTip (Win64).
const UFLAGS_OFFSET = 20;
const DW_STATE_OFFSET = 296;
const DW_STATE_MASK_OFFSET = 300;
const SZ_INFO_OFFSET = 304;
const SZ_INFO_TITLE_OFFSET = 820;
const DW_INFO_FLAGS_OFFSET = 948;
// Each buffer reserves one WCHAR for the terminating NUL.
const BALLOON_CONTENT_BYTES = MAX_TRAY_BALLOON_CONTENT_UNITS * 2;
const BALLOON_TITLE_BYTES = MAX_TRAY_BALLOON_TITLE_UNITS * 2;
const balloonIconFlags: Readonly<Record<TrayBalloon["iconType"], number>> = {
  none: 0,
  info: NIIF_INFO,
  warning: NIIF_WARNING,
  error: NIIF_ERROR,
};
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
  /** True between the shell's show and its close for one balloon, so `closed` is reported once. */
  private balloonShown = false;
  /** Registers the icon and releases partial resources if setup fails. */
  constructor(
    private readonly windows: NativeTrayWindowHost,
    tooltip: string,
    receive: (action: "show" | "quit") => void,
    notify?: (event: NativeTrayEvent) => void,
    retain?: (owner: NativeTrayOwner) => void,
    notifyHover?: (event: TrayHoverEvent) => void,
    private readonly notifyBalloon?: (event: {
      state: "show" | "click" | "closed";
    }) => void,
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
            // Explorer restarts clear notification icons, so add this one back. The shell also
            // drops any balloon that was pending, and a stale show must not suppress the next closed.
            this.added = false;
            this.balloonShown = false;
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
    if (this.handleBalloonNotification(notification)) {
      return;
    }
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
  /** Maps a shell balloon notification to `tray.balloon`; false when it is not one. */
  private handleBalloonNotification(notification: number) {
    switch (notification) {
      case NIN_BALLOONSHOW:
        this.balloonShown = true;
        this.notifyBalloon?.({
          state: "show",
        });
        return true;
      case NIN_BALLOONUSERCLICK:
        this.notifyBalloon?.({
          state: "click",
        });
        return true;
      case NIN_BALLOONHIDE:
      case NIN_BALLOONTIMEOUT:
        // Dismissal by the user, timeout, replacement and removal all end the same balloon.
        if (this.balloonShown) {
          this.balloonShown = false;
          this.notifyBalloon?.({
            state: "closed",
          });
        }
        return true;
      default:
        return false;
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
  /**
   * Asks the shell to show `balloon` from this icon, replacing one that is showing. The shell
   * gives no result for suppressed balloons (focus assist, notifications off), so a returned call
   * only means the request was accepted; `show` is the sign that it appeared. The balloon fields
   * go into a copy of the icon data, so later icon updates and Explorer re-registration never
   * repeat it.
   */
  displayBalloon(balloon: TrayBalloon) {
    if (
      balloon.title.length > MAX_TRAY_BALLOON_TITLE_UNITS ||
      balloon.content.length > MAX_TRAY_BALLOON_CONTENT_UNITS ||
      /[\0\uD800-\uDFFF]/u.test(balloon.title + balloon.content)
    ) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Invalid tray balloon.",
      });
    }
    const request = this.balloonRequest();
    Buffer.from(balloon.content, "utf16le").copy(request, SZ_INFO_OFFSET);
    Buffer.from(balloon.title, "utf16le").copy(request, SZ_INFO_TITLE_OFFSET);
    request.writeUInt32LE(
      balloonIconFlags[balloon.iconType] | (balloon.silent ? NIIF_NOSOUND : 0),
      DW_INFO_FLAGS_OFFSET,
    );
    this.modifyBalloon(request, "Tray balloon request failed.");
  }
  /** Withdraws the balloon with an empty text; the shell then reports it as closed. */
  removeBalloon() {
    this.modifyBalloon(this.balloonRequest(), "Tray balloon removal failed.");
  }
  /** A copy of the icon data with NIF_INFO set and both balloon texts cleared. */
  private balloonRequest() {
    const request = Buffer.from(this.data);
    request.writeUInt32LE(
      this.data.readUInt32LE(UFLAGS_OFFSET) | NIF_INFO,
      UFLAGS_OFFSET,
    );
    request.fill(0, SZ_INFO_OFFSET, SZ_INFO_OFFSET + BALLOON_CONTENT_BYTES + 2);
    request.fill(
      0,
      SZ_INFO_TITLE_OFFSET,
      SZ_INFO_TITLE_OFFSET + BALLOON_TITLE_BYTES + 2,
    );
    return request;
  }
  private modifyBalloon(request: Buffer, failure: string) {
    if (this.disposed) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "The tray was released.",
      });
    }
    if (!this.shell.symbols.Shell_NotifyIconW(NIM_MODIFY, ptr(request))) {
      throw new BunawayError({
        code: "INTERNAL",
        message: failure,
      });
    }
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
    this.balloonShown = false;
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
