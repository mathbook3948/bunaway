import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import type { NativeMenuItem } from "@bunaway/plugin-api/native";
import { withWide } from "./windows-buffers.ts";

const MF_POPUP = 0x10;
const MF_SEPARATOR = 0x800;
const MF_GRAYED = 0x1;
const MF_CHECKED = 0x8;
const MIIM_FTYPE = 0x100;
const MFT_RADIOCHECK = 0x200;
const MENUITEMINFO_SIZE = 80;

/** A single native popup tree. Destroying its root releases all attached submenu handles. */
export class NativePopupMenu {
  private readonly native = dlopen("user32.dll", {
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
    DestroyMenu: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
  });
  readonly handle: bigint;
  private readonly commands = new Map<number, string>();
  private nextCommand = 1;
  private disposed = false;

  constructor(items: readonly NativeMenuItem[]) {
    try {
      this.handle = this.build(items);
    } catch (error) {
      this.native.close();
      throw error;
    }
  }

  private build(items: readonly NativeMenuItem[]): bigint {
    const menu = this.native.symbols.CreatePopupMenu();
    assert(menu, "Menu creation failed.");
    try {
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
          command = this.build(item.items);
          flags |= MF_POPUP;
        } else {
          command = BigInt(this.nextCommand++);
          if (item.enabled) {
            this.commands.set(Number(command), item.id);
          }
          if (item.checked) {
            flags |= MF_CHECKED;
          }
        }
        // Labels are literal text; menu accelerators are a separate future contract.
        const appended = withWide(item.label.replaceAll("&", "&&"), (label) =>
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
      return menu;
    } catch (error) {
      this.native.symbols.DestroyMenu(menu);
      throw error;
    }
  }

  /** Resolve only a selectable leaf returned by TrackPopupMenuEx. Zero means dismissal. */
  selected(command: number): string | null {
    return this.commands.get(command) || null;
  }

  /** Idempotently release the entire tree and its FFI binding. */
  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    try {
      assert(
        this.native.symbols.DestroyMenu(this.handle),
        "Menu removal failed.",
      );
    } finally {
      this.native.close();
    }
  }
}
