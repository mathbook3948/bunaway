import { dlopen, ptr } from "bun:ffi";
import { expect, test } from "bun:test";
import { menuItemsSchema } from "#plugins/menu/src/contract";

test.skipIf(process.platform !== "win32")(
  "actual HMENU preserves item state, nested order and literal Unicode labels",
  async () => {
    const { NativePopupMenu } = await import("#plugins/tray/src/popup-menu");
    const native = dlopen("user32.dll", {
      GetMenuItemCount: {
        args: [
          "u64",
        ],
        returns: "i32",
      },
      GetSubMenu: {
        args: [
          "u64",
          "i32",
        ],
        returns: "u64",
      },
      GetMenuItemInfoW: {
        args: [
          "u64",
          "u32",
          "i32",
          "ptr",
        ],
        returns: "i32",
      },
      GetMenuStringW: {
        args: [
          "u64",
          "u32",
          "ptr",
          "i32",
          "u32",
        ],
        returns: "i32",
      },
      IsMenu: {
        args: [
          "u64",
        ],
        returns: "i32",
      },
    });
    const menu = new NativePopupMenu(
      menuItemsSchema.parse([
        {
          id: "hidden",
          type: "item",
          label: "Hidden",
          visible: false,
        },
        {
          id: "disabled",
          type: "item",
          label: "Disabled",
          enabled: false,
        },
        {
          id: "separator",
          type: "separator",
        },
        {
          id: "sub",
          type: "submenu",
          label: "한글 & 😀",
          items: [
            {
              id: "check",
              type: "checkbox",
              label: "Checked",
              checked: true,
            },
            {
              id: "radio",
              type: "radio",
              label: "Radio",
              group: "choice",
              checked: true,
            },
          ],
        },
      ]),
    );
    try {
      expect(native.symbols.GetMenuItemCount(menu.handle)).toBe(3);
      const submenu = native.symbols.GetSubMenu(menu.handle, 2);
      expect(submenu).not.toBe(0n);
      expect(native.symbols.GetMenuItemCount(submenu)).toBe(2);
      const inspect = (handle: bigint, index: number) => {
        const info = Buffer.alloc(80);
        info.writeUInt32LE(80, 0);
        info.writeUInt32LE(0x100 | 0x1 | 0x2, 4); // MIIM_FTYPE | MIIM_STATE | MIIM_ID
        expect(
          native.symbols.GetMenuItemInfoW(handle, index, 1, ptr(info)),
        ).toBe(1);
        return {
          type: info.readUInt32LE(8),
          state: info.readUInt32LE(12),
          id: info.readUInt32LE(16),
        };
      };
      expect(inspect(menu.handle, 0).state & 0x3).not.toBe(0);
      expect(inspect(menu.handle, 1).type & 0x800).toBe(0x800);
      const check = inspect(submenu, 0);
      expect(check.state & 0x8).toBe(0x8);
      expect(menu.selected(check.id)).toBe("check");
      const radio = inspect(submenu, 1);
      expect(radio.type & 0x200).toBe(0x200);
      expect(radio.state & 0x8).toBe(0x8);
      expect(menu.selected(radio.id)).toBe("radio");
      expect(menu.selected(inspect(menu.handle, 0).id)).toBeNull();
      expect(menu.selected(0)).toBeNull();
      const label = Buffer.alloc(1024);
      const length = native.symbols.GetMenuStringW(
        menu.handle,
        2,
        ptr(label),
        512,
        0x400,
      ); // MF_BYPOSITION
      expect(label.subarray(0, length * 2).toString("utf16le")).toBe(
        "한글 && 😀",
      );
      menu.dispose();
      expect(native.symbols.IsMenu(menu.handle)).toBe(0);
      expect(native.symbols.IsMenu(submenu)).toBe(0);
      menu.dispose();
    } finally {
      menu.dispose();
      native.close();
    }
  },
);
