import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import type {
  NativeMenuItem,
  NativeMenuRole,
} from "@bunaway/plugin-api/native";
import { withWide } from "./win32.ts";

const MF_POPUP = 0x10;
const MF_SEPARATOR = 0x800;
const MF_GRAYED = 0x1;
const MF_CHECKED = 0x8;
const MIIM_FTYPE = 0x100;
const MFT_RADIOCHECK = 0x200;
const MENUITEMINFO_SIZE = 80;

/** Electron's Windows shortcut text for each role. */
const ROLE_ACCELERATORS = {
  undo: "Ctrl+Z",
  redo: "Ctrl+Y",
  cut: "Ctrl+X",
  copy: "Ctrl+C",
  paste: "Ctrl+V",
  selectAll: "Ctrl+A",
} as const satisfies Record<NativeMenuRole, string>;

/** A selectable leaf: its app ID and, for a role item, the editing command it stands for. */
export type SelectedMenuItem = {
  id: string;
  role?: NativeMenuRole | undefined;
};

/** A single native popup tree. Destroying its root releases all attached submenu handles. */
export class NativePopupMenu {
  private readonly native = dlopen("user32.dll", {
    CreateMenu: {
      args: [],
      returns: "u64",
    },
    CreatePopupMenu: {
      args: [],
      returns: "u64",
    },
    AppendMenuW: {
      args: [
        "u64",
        "u32",
        "u64",
        "ptr",
      ],
      returns: "i32",
    },
    SetMenuItemInfoW: {
      args: [
        "u64",
        "u32",
        "i32",
        "ptr",
      ],
      returns: "i32",
    },
    SetMenuInfo: {
      args: [
        "u64",
        "ptr",
      ],
      returns: "i32",
    },
    GetMenuItemID: {
      args: [
        "u64",
        "i32",
      ],
      returns: "u32",
    },
    DestroyMenu: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
  });
  readonly handle: bigint;
  private readonly commands = new Map<number, SelectedMenuItem>();
  private nextCommand = 1;
  private disposed = false;
  private readonly handles = new Set<bigint>();

  constructor(
    items: readonly NativeMenuItem[],
    private readonly menuBar = false,
  ) {
    try {
      this.handle = this.build(items, menuBar);
    } catch (error) {
      this.native.close();
      throw error;
    }
  }

  private build(
    items: readonly NativeMenuItem[],
    menuBar = false,
    enabled = true,
  ): bigint {
    const menu = menuBar
      ? this.native.symbols.CreateMenu()
      : this.native.symbols.CreatePopupMenu();
    assert(menu, "Menu creation failed.");
    try {
      if (this.menuBar) {
        // WM_MENUCOMMAND carries both HMENU and position, avoiding reused command IDs.
        const info = Buffer.alloc(40); // MENUINFO, Win64
        info.writeUInt32LE(40, 0);
        info.writeUInt32LE(0x10, 4); // MIM_STYLE
        info.writeUInt32LE(0x08000000, 8); // MNS_NOTIFYBYPOS
        assert(
          this.native.symbols.SetMenuInfo(menu, ptr(info)),
          "Menu notification setup failed.",
        );
      }
      for (const item of items) {
        if (!item.visible) {
          continue;
        }
        if (item.type === "separator") {
          assert(
            this.native.symbols.AppendMenuW(menu, MF_SEPARATOR, 0n, null),
            "Menu separator failed.",
          );
          continue;
        }
        let flags = item.enabled ? 0 : MF_GRAYED;
        let command: bigint;
        if (item.type === "submenu") {
          command = this.build(item.items, false, enabled && item.enabled);
          flags |= MF_POPUP;
        } else {
          command = BigInt(this.nextCommand++);
          if (enabled && item.enabled) {
            this.commands.set(Number(command), {
              id: item.id,
              role: item.type === "item" ? item.role : undefined,
            });
          }
          if (item.checked) {
            flags |= MF_CHECKED;
          }
        }
        // Labels are literal text. A role item in a popup or submenu shows its shortcut as
        // display-only text after a tab; the page handles the real key itself. Top-level menu-bar
        // items have no accelerator column, so the text would render as a stray label tail.
        const accelerator =
          !menuBar && item.type === "item" && item.role
            ? `\t${ROLE_ACCELERATORS[item.role]}`
            : "";
        const appended = withWide(
          `${item.label.replaceAll("&", "&&")}${accelerator}`,
          (label) =>
            this.native.symbols.AppendMenuW(menu, flags, command, label),
        );
        if (!appended && item.type === "submenu") {
          this.native.symbols.DestroyMenu(command);
        }
        assert(appended, "Menu item creation failed.");
        if (item.type === "radio") {
          const info = Buffer.alloc(MENUITEMINFO_SIZE);
          info.writeUInt32LE(MENUITEMINFO_SIZE, 0);
          info.writeUInt32LE(MIIM_FTYPE, 4);
          info.writeUInt32LE(MFT_RADIOCHECK, 8);
          assert(
            this.native.symbols.SetMenuItemInfoW(
              menu,
              Number(command),
              0,
              ptr(info),
            ),
            "Menu radio presentation failed.",
          );
        }
      }
      this.handles.add(menu);
      return menu;
    } catch (error) {
      this.native.symbols.DestroyMenu(menu);
      throw error;
    }
  }

  /** Verify a WM_MENUCOMMAND source belongs to this particular tree. */
  contains(handle: bigint): boolean {
    return !this.disposed && this.handles.has(handle);
  }

  /** Resolve a native menu-bar selection only within this live tree. */
  selectedAt(handle: bigint, position: number): string | null {
    return this.selectedItemAt(handle, position)?.id ?? null;
  }

  /** Resolve only a selectable leaf returned by TrackPopupMenuEx. Zero means dismissal. */
  selected(command: number): string | null {
    return this.selectedItem(command)?.id ?? null;
  }

  /** Like `selectedAt`, also reporting the item's role so the caller can run it. */
  selectedItemAt(handle: bigint, position: number): SelectedMenuItem | null {
    return this.contains(handle)
      ? this.selectedItem(this.native.symbols.GetMenuItemID(handle, position))
      : null;
  }

  /** Like `selected`, also reporting the item's role so the caller can run it. */
  selectedItem(command: number): SelectedMenuItem | null {
    return this.disposed ? null : (this.commands.get(command) ?? null);
  }

  /** Idempotently release the entire tree and its FFI binding. */
  dispose() {
    if (this.disposed) {
      return;
    }
    assert(
      this.native.symbols.DestroyMenu(this.handle),
      "Menu removal failed.",
    );
    this.disposed = true;
    this.native.close();
  }
}
