/** An app-scoped menu resource. IDs are unique throughout one resource tree. */
export type NativeMenuItem =
  | { id: string; type: "separator"; visible: boolean }
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
  /** Null suppresses the tray context menu. Undefined restores the host's Open/Quit menu. */
  setTrayMenu(
    items: readonly NativeMenuItem[] | null | undefined,
    selected?: (itemId: string) => void,
  ): void;
  /** Sends a selection through the existing permission-filtered native event lane. */
  emit(event: string, payload: import("@bunaway/protocol").JsonValue): void;
};
