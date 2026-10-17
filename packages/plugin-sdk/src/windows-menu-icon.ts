import { dlopen, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import {
  parseNativeIco,
  selectNativeIcoFrame,
} from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";

const SM_CXSMICON = 49;
const LR_DEFAULTCOLOR = 0;
const ICON_RESOURCE_VERSION = 0x00030000;
const DI_MASK = 0x1;
const DI_IMAGE = 0x2;
const DI_NORMAL = DI_MASK | DI_IMAGE;
const BI_RGB = 0;
const DIB_RGB_COLORS = 0;
const BITMAPINFOHEADER_BYTES = 40;
const BYTES_PER_PIXEL = 4;
const OPAQUE_ALPHA = 0xff;

/**
 * Process-lifetime user32 and gdi32 bindings, opened on first use so importing this module does
 * not load DLLs. They are shared by every icon and intentionally never closed.
 */
let bindings:
  | {
      user32: ReturnType<typeof openUser32>;
      gdi32: ReturnType<typeof openGdi32>;
    }
  | undefined;

function openUser32() {
  return dlopen("user32.dll", {
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
}

function openGdi32() {
  return dlopen("gdi32.dll", {
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
    GdiFlush: {
      args: [],
      returns: "i32",
    },
  });
}

function native() {
  bindings ??= {
    user32: openUser32(),
    gdi32: openGdi32(),
  };
  return bindings;
}

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

/** Whether any BGRA pixel carries a non-zero alpha value. */
export function hasAlphaChannel(pixels: Uint8Array): boolean {
  for (let offset = 3; offset < pixels.length; offset += BYTES_PER_PIXEL) {
    if (pixels[offset] !== 0) {
      return true;
    }
  }
  return false;
}

/**
 * Build premultiplied BGRA pixels for an icon without an alpha channel. `image` is the icon drawn
 * with DI_IMAGE and `mask` the AND mask drawn with DI_MASK, where a non-zero mask pixel is
 * transparent. Opaque pixels keep their colour, including black, and transparent pixels become zero.
 */
export function composeMaskedPixels(
  image: Uint8Array,
  mask: Uint8Array,
): Uint8Array {
  const pixels = new Uint8Array(image.length);
  for (let offset = 0; offset < image.length; offset += BYTES_PER_PIXEL) {
    const transparent =
      mask[offset] !== 0 || mask[offset + 1] !== 0 || mask[offset + 2] !== 0;
    if (!transparent) {
      pixels[offset] = image[offset] ?? 0;
      pixels[offset + 1] = image[offset + 1] ?? 0;
      pixels[offset + 2] = image[offset + 2] ?? 0;
      pixels[offset + 3] = OPAQUE_ALPHA;
    }
  }
  return pixels;
}

/**
 * Convert a base64 ICO into an owned 32bpp premultiplied-alpha DIB section sized to the system
 * small-icon metric, the form `MENUITEMINFOW.hbmpItem` renders with alpha on Windows Vista and later.
 * The caller owns the bitmap and must release it with `releaseMenuIconBitmap` only after the menu
 * item that uses it is gone. Build one bitmap per menu instance so lifetimes never overlap.
 *
 * Icons with an alpha channel keep it. Icons without one take their transparency from the AND mask.
 *
 * Throws INVALID_ARGUMENT when the ICO is malformed or Windows rejects its image, and a plain
 * Error when a GDI resource cannot be created.
 */
export function createMenuIconBitmap(ico: string): bigint {
  const frames = parseNativeIco(ico) ?? rejected("Invalid menu ICO image.");
  const { user32, gdi32 } = native();
  let icon = 0n;
  let screen = 0n;
  let memory = 0n;
  let bitmap = 0n;
  let previous = 0n;
  try {
    const size = user32.symbols.GetSystemMetrics(SM_CXSMICON);
    const frame = selectNativeIcoFrame(frames, size);
    if (size <= 0 || !frame) {
      throw new Error("Menu icon size is unavailable.");
    }
    // RT_ICON bits must be DWORD-aligned, so copy the frame out of the ICO payload.
    const image = Buffer.from(frame.data);
    icon = pin(image, (address) =>
      user32.symbols.CreateIconFromResourceEx(
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
    screen = user32.symbols.GetDC(0n);
    memory = gdi32.symbols.CreateCompatibleDC(screen);
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
        gdi32.symbols.CreateDIBSection(
          screen,
          info,
          DIB_RGB_COLORS,
          out,
          0n,
          0,
        ),
      ),
    );
    const address = Number(bits.readBigUInt64LE(0));
    if (!screen || !memory || !bitmap || !address) {
      throw new Error("Menu icon bitmap creation failed.");
    }
    // The section memory is shared with GDI, so draw, flush, then read through the same view.
    const pixels = new Uint8Array(
      toArrayBuffer(address as Pointer, 0, size * size * BYTES_PER_PIXEL),
    );
    previous = gdi32.symbols.SelectObject(memory, bitmap);
    const draw = (flags: number) => {
      pixels.fill(0);
      if (
        !user32.symbols.DrawIconEx(memory, 0, 0, icon, size, size, 0, 0n, flags)
      ) {
        throw new Error("Menu icon drawing failed.");
      }
      gdi32.symbols.GdiFlush();
    };
    // A fresh section is zeroed, so an icon with alpha composes onto transparent black.
    draw(DI_NORMAL);
    if (!hasAlphaChannel(pixels)) {
      draw(DI_IMAGE);
      const color = pixels.slice();
      draw(DI_MASK);
      pixels.set(composeMaskedPixels(color, pixels));
    }
    gdi32.symbols.SelectObject(memory, previous);
    previous = 0n;
    const created = bitmap;
    bitmap = 0n;
    return created;
  } finally {
    if (previous) {
      gdi32.symbols.SelectObject(memory, previous);
    }
    if (bitmap) {
      gdi32.symbols.DeleteObject(bitmap);
    }
    if (memory) {
      gdi32.symbols.DeleteDC(memory);
    }
    if (screen) {
      user32.symbols.ReleaseDC(0n, screen);
    }
    if (icon) {
      user32.symbols.DestroyIcon(icon);
    }
  }
}

/** Free a bitmap from `createMenuIconBitmap`. Safe to repeat for a zero handle. */
export function releaseMenuIconBitmap(bitmap: bigint): void {
  if (bitmap) {
    native().gdi32.symbols.DeleteObject(bitmap);
  }
}
