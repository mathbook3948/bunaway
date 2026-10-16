/** An app-scoped menu resource. IDs are unique throughout one resource tree. */
export type NativeMenuItem =
  | {
      id: string;
      type: "separator";
      visible: boolean;
    }
  | {
      id: string;
      type: "item" | "checkbox" | "radio";
      label: string;
      enabled: boolean;
      visible: boolean;
      checked: boolean;
      /** Radio groups are scoped to their immediate containing menu. */
      group: string | null;
    }
  | {
      id: string;
      type: "submenu";
      label: string;
      enabled: boolean;
      visible: boolean;
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
  /** Resize the WebView and refresh the observed content bounds after menu attachment changes. */
  changed(windowId: string): void;
};
