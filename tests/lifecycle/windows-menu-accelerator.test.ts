import { dlopen, ptr } from "bun:ffi";
import { expect, test } from "bun:test";
import { menuItemsSchema } from "#plugins/menu/src/contract";

const MF_BYPOSITION = 0x400;

test.skipIf(process.platform !== "win32")(
  "actual HMENU draws the accelerator after a tab, and a role keeps its default unless overridden",
  async () => {
    const { NativePopupMenu } = await import(
      "#plugins/tray/src/platforms/windows-popup-menu"
    );
    const native = dlopen("user32.dll", {
      GetSubMenu: {
        args: [
          "u64",
          "i32",
        ],
        returns: "u64",
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
    });
    const menuText = (menu: bigint, position: number) => {
      const buffer = Buffer.alloc(512);
      const length = native.symbols.GetMenuStringW(
        menu,
        position,
        ptr(buffer),
        buffer.length / 2,
        MF_BYPOSITION,
      );
      return buffer.subarray(0, length * 2).toString("utf16le");
    };
    const popup = new NativePopupMenu(
      menuItemsSchema.parse([
        {
          id: "new",
          type: "item",
          label: "New & Open",
          accelerator: "cmdorctrl+shift+n",
        },
        {
          id: "plain",
          type: "item",
          label: "Plain",
        },
        {
          id: "check",
          type: "checkbox",
          label: "Check",
          accelerator: "F11",
        },
        {
          id: "radio",
          type: "radio",
          label: "Radio",
          group: "choice",
          accelerator: "Alt+Win+Left",
        },
        {
          id: "copy",
          type: "item",
          role: "copy",
        },
        {
          id: "custom-copy",
          type: "item",
          role: "copy",
          accelerator: "Ctrl+Insert",
        },
        {
          id: "sub",
          type: "submenu",
          label: "Sub",
          items: [
            {
              id: "inner",
              type: "item",
              label: "Inner",
              accelerator: "Ctrl+I",
            },
          ],
        },
      ]),
    );
    try {
      expect(
        Array.from(
          {
            length: 7,
          },
          (_, position) => menuText(popup.handle, position),
        ),
      ).toEqual([
        "New && Open\tCtrl+Shift+N",
        "Plain",
        "Check\tF11",
        "Radio\tAlt+Win+Left",
        "Copy\tCtrl+C",
        "Copy\tCtrl+Insert",
        "Sub",
      ]);
      const submenu = native.symbols.GetSubMenu(popup.handle, 6);
      expect(menuText(submenu, 0)).toBe("Inner\tCtrl+I");
    } finally {
      popup.dispose();
      native.close();
    }
  },
);
