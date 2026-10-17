import { dlopen, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import {
  parseNativeMenuIco,
  selectNativeMenuIcoFrame,
} from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";

const SM_CXSMICON = 49;
const LR_DEFAULTCOLOR = 0;
const ICON_RESOURCE_VERSION = 0x00030000;
const DI_NORMAL = 0x3;
const BI_RGB = 0;
const DIB_RGB_COLORS = 0;
const BITMAPINFOHEADER_BYTES = 40;
const BYTES_PER_PIXEL = 4;
const OPAQUE_ALPHA = 0xff;

// Keep native input alive across the synchronous call that reads it.
const pinned = new Set<Buffer>();
function pin<T extends number | bigint>(
  buffer: Buffer,
  invoke: (address: Pointer) => T,
): T {
  pinned.add(buffer);
  try {
    return invoke(ptr(buffer));
  } finally {
    pinned.delete(buffer);
  }
}

function rejected(message: string): never {
  throw new BunawayError({
    code: "INVALID_ARGUMENT",
    message,
  });
}

/**
 * Convert a base64 ICO into an owned 32bpp premultiplied-alpha DIB section sized to the system
 * small-icon metric, the form `MENUITEMINFOW.hbmpItem` renders with alpha on Windows Vista and later.
 * The caller owns the bitmap and must release it with `releaseMenuIconBitmap` only after the menu
 * item that uses it is gone. Build one bitmap per menu instance so lifetimes never overlap.
 *
 * Throws INVALID_ARGUMENT when the ICO is malformed or Windows rejects its image, and a plain
 * Error when a GDI resource cannot be created.
 */
export function createMenuIconBitmap(ico: string): bigint {
  const frames = parseNativeMenuIco(ico) ?? rejected("Invalid menu ICO image.");
  const native = dlopen("user32.dll", {
    GetSystemMetrics: {
      args: [
        "i32",
      ],
      returns: "i32",
    },
    CreateIconFromResourceEx: {
      args: [
        "ptr",
        "u32",
        "i32",
        "u32",
        "i32",
        "i32",
        "u32",
      ],
      returns: "u64",
    },
    DrawIconEx: {
      args: [
        "u64",
        "i32",
        "i32",
        "u64",
        "i32",
        "i32",
        "u32",
        "u64",
        "u32",
      ],
      returns: "i32",
    },
    DestroyIcon: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
    GetDC: {
      args: [
        "u64",
      ],
      returns: "u64",
    },
    ReleaseDC: {
      args: [
        "u64",
        "u64",
      ],
      returns: "i32",
    },
  });
  const gdi = dlopen("gdi32.dll", {
    CreateCompatibleDC: {
      args: [
        "u64",
      ],
      returns: "u64",
    },
    CreateDIBSection: {
      args: [
        "u64",
        "ptr",
        "u32",
        "ptr",
        "u64",
        "u32",
      ],
      returns: "u64",
    },
    SelectObject: {
      args: [
        "u64",
        "u64",
      ],
      returns: "u64",
    },
    DeleteObject: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
    DeleteDC: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
  });
  let icon = 0n;
  let screen = 0n;
  let memory = 0n;
  let bitmap = 0n;
  let previous = 0n;
  try {
    const size = native.symbols.GetSystemMetrics(SM_CXSMICON);
    const frame = selectNativeMenuIcoFrame(frames, size);
    if (size <= 0 || !frame) {
      throw new Error("Menu icon size is unavailable.");
    }
    // RT_ICON bits must be DWORD-aligned, so copy the frame out of the ICO payload.
    const image = Buffer.from(frame.image);
    icon = pin(image, (address) =>
      native.symbols.CreateIconFromResourceEx(
        address,
        image.length,
        1,
        ICON_RESOURCE_VERSION,
        size,
        size,
        LR_DEFAULTCOLOR,
      ),
    );
    if (!icon) {
      rejected("Windows rejected the menu ICO image.");
    }
    screen = native.symbols.GetDC(0n);
    memory = gdi.symbols.CreateCompatibleDC(screen);
    // A negative height makes the DIB top-down so pixel rows read in raster order.
    const header = Buffer.alloc(BITMAPINFOHEADER_BYTES);
    header.writeUInt32LE(BITMAPINFOHEADER_BYTES, 0);
    header.writeInt32LE(size, 4);
    header.writeInt32LE(-size, 8);
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(BYTES_PER_PIXEL * 8, 14);
    header.writeUInt32LE(BI_RGB, 16);
    const bits = Buffer.alloc(8);
    bitmap = pin(header, (info) =>
      pin(bits, (out) =>
        gdi.symbols.CreateDIBSection(screen, info, DIB_RGB_COLORS, out, 0n, 0),
      ),
    );
    const address = Number(bits.readBigUInt64LE(0));
    if (!screen || !memory || !bitmap || !address) {
      throw new Error("Menu icon bitmap creation failed.");
    }
    previous = gdi.symbols.SelectObject(memory, bitmap);
    // The fresh section is zeroed, so drawing composes the icon onto transparent black.
    if (
      !native.symbols.DrawIconEx(
        memory,
        0,
        0,
        icon,
        size,
        size,
        0,
        0n,
        DI_NORMAL,
      )
    ) {
      throw new Error("Menu icon drawing failed.");
    }
    gdi.symbols.SelectObject(memory, previous);
    previous = 0n;
    makeOpaqueWithoutAlpha(
      new Uint8Array(
        toArrayBuffer(address as Pointer, 0, size * size * BYTES_PER_PIXEL),
      ),
    );
    const created = bitmap;
    bitmap = 0n;
    return created;
  } finally {
    if (previous) {
      gdi.symbols.SelectObject(memory, previous);
    }
    if (bitmap) {
      gdi.symbols.DeleteObject(bitmap);
    }
    if (memory) {
      gdi.symbols.DeleteDC(memory);
    }
    if (screen) {
      native.symbols.ReleaseDC(0n, screen);
    }
    if (icon) {
      native.symbols.DestroyIcon(icon);
    }
    gdi.close();
    native.close();
  }
}

/**
 * Icons without an alpha channel draw with zero alpha, which would make them invisible as a
 * premultiplied bitmap. When no pixel carries alpha, treat every drawn pixel as opaque.
 */
function makeOpaqueWithoutAlpha(pixels: Uint8Array): void {
  let drawn = false;
  for (let offset = 0; offset < pixels.length; offset += BYTES_PER_PIXEL) {
    if (pixels[offset + 3] !== 0) {
      return;
    }
    drawn ||=
      pixels[offset] !== 0 ||
      pixels[offset + 1] !== 0 ||
      pixels[offset + 2] !== 0;
  }
  if (!drawn) {
    return;
  }
  for (let offset = 0; offset < pixels.length; offset += BYTES_PER_PIXEL) {
    if (
      pixels[offset] !== 0 ||
      pixels[offset + 1] !== 0 ||
      pixels[offset + 2] !== 0
    ) {
      pixels[offset + 3] = OPAQUE_ALPHA;
    }
  }
}

/** Free a bitmap from `createMenuIconBitmap`. Safe to repeat for a zero handle. */
export function releaseMenuIconBitmap(bitmap: bigint): void {
  if (!bitmap) {
    return;
  }
  const gdi = dlopen("gdi32.dll", {
    DeleteObject: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
  });
  try {
    gdi.symbols.DeleteObject(bitmap);
  } finally {
    gdi.close();
  }
}
