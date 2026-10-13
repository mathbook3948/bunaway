/** Win64 NOTIFYICONDATAW has room for 127 UTF-16 units plus the terminating NUL. */
export const MAX_TRAY_TOOLTIP_UNITS = 127;
/** Bound image allocation before passing ICO data to Windows. */
export const MAX_TRAY_ICO_BYTES = 65_536;
export const MAX_TRAY_WAITERS = 16;

/** Snapshot of the single tray icon declared by desktop.tray. */
export type NativeTraySnapshot = {
  id: "main";
  tooltip: string;
  icon: "app" | "custom";
  showOnLeftClick: boolean;
  menuOnRightClick: boolean;
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
  focus(): boolean;
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
};

/** Resource retained by the host until native callback quiescence and retryable cleanup. */
export type NativeTrayOwner = Pick<
  NativeTrayServices,
  "get" | "getBounds" | "setTooltip" | "setIcon" | "setClickBehavior" | "focus"
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
  receive(action: "show" | "quit"): void;
  notify(event: NativeTrayEvent): void;
  /** Retain partial ownership before shell registration; failed startup releases remain retryable. */
  retain(owner: NativeTrayOwner): void;
};
