/**
 * Editing commands the host runs on the window's page. The names are Chromium editing command
 * names, so they double as the protocol command sent to the WebView.
 */
export type NativeMenuRole =
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll";

/** An app-scoped menu resource. IDs are unique throughout one resource tree. */
export type NativeMenuItem =
  | {
      id: string;
      type: "separator";
      visible: boolean;
    }
  | {
      id: string;
      type: "item";
      /** Resolved label; the role's default when the definition omitted it. */
      label: string;
      enabled: boolean;
      visible: boolean;
      checked: boolean;
      group: string | null;
      /** Base64 ICO shown before the label; null or omitted means no icon. */
      icon?: string | null | undefined;
      /** Normalized display-only shortcut text; overrides the role's default. Null or omitted shows none. */
      accelerator?: string | null | undefined;
      /** A role item runs its editing command itself and is never reported as a selection. */
      role?: NativeMenuRole | undefined;
    }
  | {
      id: string;
      type: "checkbox" | "radio";
      label: string;
      enabled: boolean;
      visible: boolean;
      checked: boolean;
      /** Radio groups are scoped to their immediate containing menu. */
      group: string | null;
      /** Normalized display-only shortcut text; null or omitted shows none. */
      accelerator?: string | null | undefined;
    }
  | {
      id: string;
      type: "submenu";
      label: string;
      enabled: boolean;
      visible: boolean;
      /** Base64 ICO shown before the label; null or omitted means no icon. */
      icon?: string | null | undefined;
      items: NativeMenuItem[];
    };

/** UI-thread tray integration. Menu replacement does not change icon or app lifetime. */
export type NativeMenuServices = {
  /** Available only on the owning Windows UI thread. */
  windows?: NativeMenuWindowHost;
  /** Null suppresses the tray context menu. Undefined restores the host's Open/Quit menu. */
  setTrayMenu(
    items: readonly NativeMenuItem[] | null | undefined,
    selected?: (itemId: string) => void,
  ): void;
  /** Sends a selection through the existing permission-filtered native event lane. */
  emit(event: string, payload: import("@bunaway/protocol").JsonValue): void;
};

/** Borrowed live app-window facilities. HWNDs never cross the public operation boundary. */
export type NativeMenuWindowHost = {
  /** Reject unknown or closing window lifetimes with INVALID_ARGUMENT. */
  resolve(windowId: string): bigint;
  /** Notify before HWND destruction. The subscriber detaches/releases its native menus. */
  subscribe(
    windowId: string,
    receive: (message: number, wparam: bigint, lparam: bigint) => void,
    closing: () => void,
  ): () => void;
  /** Register only modal-loop termination for validated cancellation/shutdown. Cleanup stays deferred. */
  interrupt(signal: AbortSignal | undefined, cancel: () => void): () => void;
  /**
   * Run a menu role on the window's page. A closed window or missing WebView is ignored with a
   * diagnostic, because a menu selection is user input and must not fail the app.
   */
  executeRole(windowId: string, role: NativeMenuRole): void;
  /** Resize the WebView and refresh the observed content bounds after menu attachment changes. */
  changed(windowId: string): void;
};
