import { MAX_NATIVE_ICO_BYTES } from "./native-ico.ts";

/** Win64 NOTIFYICONDATAW has room for 127 UTF-16 units plus the terminating NUL. */
export const MAX_TRAY_TOOLTIP_UNITS = 127;
/** Bound image allocation before passing ICO data to Windows. Alias of the shared ICO limit. */
export const MAX_TRAY_ICO_BYTES = MAX_NATIVE_ICO_BYTES;
export const MAX_TRAY_WAITERS = 16;

/** Snapshot of the single tray icon declared by desktop.tray. */
export type NativeTraySnapshot = {
  id: "main";
  tooltip: string;
  icon: "app" | "custom";
  showOnLeftClick: boolean;
  menuOnRightClick: boolean;
  /** False while the icon is hidden. The registration, tooltip, icon and menu are kept. */
  visible: boolean;
};
/** Classic shell notifications, with observed physical pointer coordinates when available. */
export type NativeTrayEvent = {
  id: "main";
  button: "left" | "right" | "middle" | "none";
  state: "down" | "up" | "double-click" | "context-menu";
  position: {
    x: number;
    y: number;
  } | null;
};
/** Host integration for the selected tray implementation. Controls preserve configured app residency. */
export type NativeTrayServices = {
  /** Called only by the registered tray adapter. Host owns the returned resource until cleanup completes. */
  initialize?(
    create: (initialization: NativeTrayInitialization) => NativeTrayOwner,
  ): void;
  get(): NativeTraySnapshot | null;
  getBounds(): {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  setTooltip(tooltip: string): void;
  /** Base64 ICO data, or null to restore the host-owned app icon. No file paths are accepted. */
  setIcon(ico: string | null): void;
  setClickBehavior(showOnLeftClick: boolean, menuOnRightClick: boolean): void;
  /** Hides or shows the registered icon without releasing it. Hidden bounds are null and focus is false. */
  setVisible(visible: boolean): void;
  focus(): boolean;
  /**
   * Tracks the menu attached with `setTrayMenu` at a physical screen position (null for the
   * pointer) until a choice, dismissal or `signal` abort. A choice is delivered through the
   * attachment's selection callback, not the return value. Throws INVALID_ARGUMENT without an
   * attached menu, BUSY while a popup is open, and CANCELLED when `signal` aborts.
   */
  popUpContextMenu(
    position: {
      x: number;
      y: number;
    } | null,
    signal: AbortSignal,
  ): void;
  /** The adapter must release this subscription during disposal. */
  subscribe(receive: (event: NativeTrayEvent) => void): () => void;
  emit(event: string, payload: import("@bunaway/protocol").JsonValue): void;
};

/** Narrow borrowed window facilities. The tray owns its hidden HWND and custom icons. */
export type NativeTrayWindowHost = {
  readonly icon: bigint | undefined;
  create(
    title: string,
    width: number,
    height: number,
    receive: (message: number, wparam: bigint, lparam: bigint) => void,
    visible: false,
  ): bigint;
  destroy(hwnd: bigint): void;
  /**
   * Ends a native menu loop when the request owning `signal` is cancelled or the host shuts down.
   * Returns the unsubscribe function. Hosts that cannot interrupt a menu loop omit it, and the
   * tray then rejects `popUpContextMenu` with UNSUPPORTED.
   */
  interrupt?(signal: AbortSignal, cancel: () => void): () => void;
};

/** Resource retained by the host until native callback quiescence and retryable cleanup. */
export type NativeTrayOwner = Pick<
  NativeTrayServices,
  | "get"
  | "getBounds"
  | "setTooltip"
  | "setIcon"
  | "setClickBehavior"
  | "setVisible"
  | "focus"
  | "popUpContextMenu"
> & {
  readonly hwnd: bigint;
  setMenu(
    items:
      | readonly import("./native-menu.ts").NativeMenuItem[]
      | null
      | undefined,
    selected?: (itemId: string) => void,
  ): void;
  dispose(): void;
};

/** Supplies validated residency configuration to the optional tray implementation. */
export type NativeTrayInitialization = {
  windows: NativeTrayWindowHost;
  tooltip: string;
  /**
   * The icon path declared by `desktop.tray.icon`, relative to `resources`. The tray adapter owns
   * validating and reading it; absent means the app icon.
   */
  icon?: string;
  /** Directory of files shipped with the app, the base of `icon`. */
  resources?: string;
  receive(action: "show" | "quit"): void;
  notify(event: NativeTrayEvent): void;
  /** Retain partial ownership before shell registration; failed startup releases remain retryable. */
  retain(owner: NativeTrayOwner): void;
};
