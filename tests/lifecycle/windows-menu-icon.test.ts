import { dlopen, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { expect, test } from "bun:test";
import { menuItemsSchema } from "#plugins/menu/src/contract";
import { trayIco, trayPngIco } from "../fixtures/tray-icon.ts";

const SM_CXSMICON = 49;
const MIIM_BITMAP = 0x80;
const MENUITEMINFO_SIZE = 80;
const HBMPITEM_OFFSET = 72;
const BITMAP_SIZE = 32;

const user32 = () =>
  dlopen("user32.dll", {
    GetMenuItemInfoW: {
      args: [
        "u64",
        "u32",
        "i32",
        "ptr",
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
    GetSystemMetrics: {
      args: [
        "i32",
      ],
      returns: "i32",
    },
  });
const gdi32 = () =>
  dlopen("gdi32.dll", {
    GetObjectW: {
      args: [
        "u64",
        "i32",
        "ptr",
      ],
      returns: "i32",
    },
  });

test.skipIf(process.platform !== "win32")(
  "actual HMENU items carry a 32bpp small-icon bitmap that is replaced, removed and freed with the tree",
  async () => {
    const { NativePopupMenu } = await import(
      "#plugins/tray/src/platforms/windows-popup-menu"
    );
    const native = user32();
    const objects = gdi32();
    const size = native.symbols.GetSystemMetrics(SM_CXSMICON);
    const bitmapAt = (menu: bigint, position: number) => {
      const info = Buffer.alloc(MENUITEMINFO_SIZE);
      info.writeUInt32LE(MENUITEMINFO_SIZE, 0);
      info.writeUInt32LE(MIIM_BITMAP, 4);
      expect(
        native.symbols.GetMenuItemInfoW(menu, position, 1, ptr(info)),
      ).toBe(1);
      return info.readBigUInt64LE(HBMPITEM_OFFSET);
    };
    const describe = (bitmap: bigint) => {
      const info = Buffer.alloc(BITMAP_SIZE);
      const written = objects.symbols.GetObjectW(
        bitmap,
        BITMAP_SIZE,
        ptr(info),
      );
      return {
        written,
        width: info.readInt32LE(4),
        height: info.readInt32LE(8),
        bitsPerPixel: info.readUInt16LE(18),
        bits: Number(info.readBigUInt64LE(24)),
      };
    };
    const items = (icon: string | null, secondIcon: string | null) =>
      menuItemsSchema.parse([
        {
          id: "hidden",
          type: "item",
          label: "Hidden",
          visible: false,
          icon,
        },
        {
          id: "first",
          type: "item",
          label: "First",
          icon,
        },
        {
          id: "separator",
          type: "separator",
        },
        {
          id: "check",
          type: "checkbox",
          label: "Check",
        },
        {
          id: "sub",
          type: "submenu",
          label: "Sub",
          icon: secondIcon,
          items: [
            {
              id: "nested",
              type: "item",
              label: "Nested",
              icon: secondIcon,
            },
          ],
        },
      ]);
    const dib = trayIco().toString("base64");
    const png = trayPngIco().toString("base64");
    const created: bigint[] = [];
    try {
      const first = new NativePopupMenu(items(dib, png));
      const firstSub = native.symbols.GetSubMenu(first.handle, 3);
      // The hidden item is skipped, so "first" is position 0 and the submenu is position 3.
      const firstBitmap = bitmapAt(first.handle, 0);
      const subBitmap = bitmapAt(first.handle, 3);
      const nestedBitmap = bitmapAt(firstSub, 0);
      created.push(firstBitmap, subBitmap, nestedBitmap);
      expect(firstBitmap).not.toBe(0n);
      expect(subBitmap).not.toBe(0n);
      expect(nestedBitmap).not.toBe(0n);
      // Every item gets its own bitmap, so disposing one tree never frees another's.
      expect(new Set(created).size).toBe(3);
      expect(bitmapAt(first.handle, 1)).toBe(0n);
      expect(bitmapAt(first.handle, 2)).toBe(0n);

      const described = describe(firstBitmap);
      expect(described).toMatchObject({
        written: BITMAP_SIZE,
        width: size,
        height: size,
        bitsPerPixel: 32,
      });
      // The opaque BGRA fixture keeps its colour and full alpha in the premultiplied DIB.
      const pixel = new Uint8Array(
        toArrayBuffer(described.bits as unknown as Pointer, 0, 4),
      );
      expect([
        ...pixel,
      ]).toEqual([
        32,
        96,
        200,
        255,
      ]);
      expect(describe(subBitmap).bitsPerPixel).toBe(32);

      // A second tree built for the same menu resource holds independent bitmaps.
      const second = new NativePopupMenu(items(png, null));
      const secondBitmap = bitmapAt(second.handle, 0);
      created.push(secondBitmap);
      expect(secondBitmap).not.toBe(0n);
      expect(secondBitmap).not.toBe(firstBitmap);
      expect(bitmapAt(second.handle, 3)).toBe(0n);

      first.dispose();
      for (const bitmap of [
        firstBitmap,
        subBitmap,
        nestedBitmap,
      ]) {
        expect(describe(bitmap).written).toBe(0);
      }
      expect(describe(secondBitmap).written).toBe(BITMAP_SIZE);
      second.dispose();
      expect(describe(secondBitmap).written).toBe(0);
      second.dispose();
    } finally {
      native.close();
      objects.close();
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "a well-formed ICO directory with an undecodable image is INVALID_ARGUMENT",
  async () => {
    const { createMenuIconBitmap } = await import(
      "../../packages/plugin-sdk/src/windows-menu-icon.ts"
    );
    const broken = Buffer.from(trayIco());
    broken.fill(0xab, 22);
    expect(() => createMenuIconBitmap(broken.toString("base64"))).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  },
);
