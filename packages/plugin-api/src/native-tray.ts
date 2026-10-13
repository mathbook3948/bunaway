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
/** UI-thread controls for the configured tray. They do not create/remove it or change app residency. */
export type NativeTrayServices = {
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
