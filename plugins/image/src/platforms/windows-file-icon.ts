import { CFunction, dlopen, type Pointer, ptr, read } from "bun:ffi";
import { pick, USER32, wide } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";
import type { FileTypeIconSize } from "#image/contract";
import type { FileTypeIconSource, Pixels } from "#image/platforms/codec";

const FILE_ATTRIBUTE_NORMAL = 0x80;
const SHGFI_SYSICONINDEX = 0x4000;
const SHGFI_USEFILEATTRIBUTES = 0x10;
const SHFILEINFOW_BYTES = 696;
const SHFILEINFO_ICON_INDEX_OFFSET = 8;
/** Shell image list sizes: SHIL_LARGE is 32, SHIL_SMALL 16 and SHIL_EXTRALARGE 48 pixels at 100% scale. */
const SHIL_BY_SIZE: Record<FileTypeIconSize, number> = {
  small: 1,
  normal: 0,
  large: 2,
};
const ILD_TRANSPARENT = 0x1;
const IMAGE_LIST_RELEASE_SLOT = 2;
const IMAGE_LIST_GET_ICON_SLOT = 10;
/** IID_IImageList 46EB5926-582E-4017-9FDF-E8998DAA0950 in COM byte order. */
const IID_IIMAGELIST = Buffer.from("2659eb462e5817409fdfe8998daa0950", "hex");
const ICONINFO_BYTES = 32;
const ICONINFO_MASK_OFFSET = 16;
const ICONINFO_COLOR_OFFSET = 24;
const BITMAP_BYTES = 32;
const BITMAP_WIDTH_OFFSET = 4;
const BITMAP_HEIGHT_OFFSET = 8;
const BITMAPINFOHEADER_BYTES = 40;
const BI_RGB = 0;
const DIB_RGB_COLORS = 0;
const BYTES_PER_PIXEL = 4;
const OPAQUE_ALPHA = 0xff;
/** Shell icon lists top out at 256 pixels; anything larger indicates a bad bitmap. */
const MAX_ICON_EDGE = 256;

function failed(message: string): never {
  throw new BunawayError({
    code: "INTERNAL",
    message,
  });
}

/** Whether any BGRA pixel carries a non-zero alpha value. */
function hasAlphaChannel(bgra: Buffer): boolean {
  for (let offset = 3; offset < bgra.length; offset += BYTES_PER_PIXEL) {
    if (bgra[offset] !== 0) {
      return true;
    }
  }
  return false;
}

/**
 * Convert BGRA to straight RGBA. Icons with an alpha channel keep it. Others are opaque except where
 * the 32bpp-expanded AND mask is non-zero, which marks transparent pixels and is cleared to zero.
 */
function toRgba(bgra: Buffer, andMask?: Buffer): Buffer {
  const hasAlpha = andMask === undefined && hasAlphaChannel(bgra);
  const rgba = Buffer.alloc(bgra.length);
  for (let offset = 0; offset < bgra.length; offset += BYTES_PER_PIXEL) {
    if (andMask && andMask[offset] !== 0) {
      continue;
    }
    rgba[offset] = bgra[offset + 2] ?? 0;
    rgba[offset + 1] = bgra[offset + 1] ?? 0;
    rgba[offset + 2] = bgra[offset] ?? 0;
    rgba[offset + 3] = hasAlpha ? (bgra[offset + 3] ?? 0) : OPAQUE_ALPHA;
  }
  return rgba;
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new BunawayError({
      code: "CANCELLED",
      message: "Image creation cancelled.",
    });
  }
}

/**
 * Open the shell, user32 and gdi32 bindings used to rasterize file type icons. The source never
 * reads the file system: SHGFI_USEFILEATTRIBUTES makes the shell resolve the icon from the
 * extension registration alone, so the app needs no storage permission and no real path exists.
 * Call `dispose` to close the libraries.
 */
export function createFileTypeIconSource(): FileTypeIconSource {
  const shell32 = dlopen("shell32.dll", {
    SHGetFileInfoW: {
      args: [
        "ptr",
        "u32",
        "ptr",
        "u32",
        "u32",
      ],
      returns: "u64",
    },
    SHGetImageList: {
      args: [
        "i32",
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
  });
  let user32: ReturnType<typeof openUser32>;
  let gdi32: ReturnType<typeof openGdi32>;
  try {
    user32 = openUser32();
    try {
      gdi32 = openGdi32();
    } catch (error) {
      user32.close();
      throw error;
    }
  } catch (error) {
    shell32.close();
    throw error;
  }
  let disposed = false;

  /** Read one bitmap's 32bpp top-down pixels as BGRA through the screen DC. */
  function readBitmap(
    screen: bigint,
    bitmap: bigint,
    width: number,
    height: number,
  ): Buffer {
    const header = Buffer.alloc(BITMAPINFOHEADER_BYTES);
    header.writeUInt32LE(BITMAPINFOHEADER_BYTES, 0);
    header.writeInt32LE(width, 4);
    // A negative height requests top-down rows, the raster order of the result.
    header.writeInt32LE(-height, 8);
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(BYTES_PER_PIXEL * 8, 14);
    header.writeUInt32LE(BI_RGB, 16);
    const bits = Buffer.alloc(width * height * BYTES_PER_PIXEL);
    const lines = gdi32.symbols.GetDIBits(
      screen,
      bitmap,
      0,
      height,
      ptr(bits),
      ptr(header),
      DIB_RGB_COLORS,
    );
    if (lines !== height) {
      failed("Windows file icon bitmap could not be read.");
    }
    return bits;
  }

  /** Convert an HICON to straight RGBA, restoring alpha from the AND mask for icons without an alpha channel. */
  function iconPixels(icon: bigint): Pixels {
    const info = Buffer.alloc(ICONINFO_BYTES);
    if (!user32.symbols.GetIconInfo(icon, ptr(info))) {
      failed("Windows file icon information is unavailable.");
    }
    const mask = info.readBigUInt64LE(ICONINFO_MASK_OFFSET);
    const color = info.readBigUInt64LE(ICONINFO_COLOR_OFFSET);
    let screen = 0n;
    try {
      if (!color) {
        failed("Windows file icon has no color bitmap.");
      }
      const bitmap = Buffer.alloc(BITMAP_BYTES);
      if (
        !gdi32.symbols.GetObjectW(color, BITMAP_BYTES, ptr(bitmap)) ||
        bitmap.readInt32LE(BITMAP_WIDTH_OFFSET) <= 0
      ) {
        failed("Windows file icon size is unavailable.");
      }
      const width = bitmap.readInt32LE(BITMAP_WIDTH_OFFSET);
      const height = bitmap.readInt32LE(BITMAP_HEIGHT_OFFSET);
      if (height <= 0 || width > MAX_ICON_EDGE || height > MAX_ICON_EDGE) {
        failed("Windows file icon size is unsupported.");
      }
      screen = user32.symbols.GetDC(0n);
      if (!screen) {
        failed("Windows screen device context is unavailable.");
      }
      const bgra = readBitmap(screen, color, width, height);
      const andMask =
        !hasAlphaChannel(bgra) && mask
          ? readBitmap(screen, mask, width, height)
          : undefined;
      return {
        width,
        height,
        rgba: toRgba(bgra, andMask),
      };
    } finally {
      if (screen) {
        user32.symbols.ReleaseDC(0n, screen);
      }
      if (color) {
        gdi32.symbols.DeleteObject(color);
      }
      if (mask) {
        gdi32.symbols.DeleteObject(mask);
      }
    }
  }

  /** Resolve the shell icon index of an extension without a file system lookup. */
  function iconIndex(extension: string): number {
    const name = wide(`file${extension}`);
    const fileInfo = Buffer.alloc(SHFILEINFOW_BYTES);
    const result = shell32.symbols.SHGetFileInfoW(
      ptr(name),
      FILE_ATTRIBUTE_NORMAL,
      ptr(fileInfo),
      SHFILEINFOW_BYTES,
      SHGFI_USEFILEATTRIBUTES | SHGFI_SYSICONINDEX,
    );
    if (!result) {
      failed("Windows file type icon lookup failed.");
    }
    return fileInfo.readInt32LE(SHFILEINFO_ICON_INDEX_OFFSET);
  }

  /** Bind one IImageList method by vtable slot; the caller closes the binding after its call. */
  function bindImageListMethod(
    list: Pointer,
    slot: number,
    args: ("ptr" | "i32" | "u32")[],
    returns: "i32" | "u32",
  ) {
    const address = read.ptr(read.ptr(list), slot * 8);
    if (!address) {
      failed("Windows image list interface is unavailable.");
    }
    return CFunction({
      ptr: address as Pointer,
      args: [
        "ptr",
        ...args,
      ],
      returns,
    });
  }

  /** Extract an owned HICON for a shell icon index, releasing the borrowed image list before returning. */
  function extractIcon(size: FileTypeIconSize, index: number): bigint {
    const out = new BigUint64Array(1);
    const listResult = shell32.symbols.SHGetImageList(
      SHIL_BY_SIZE[size],
      ptr(IID_IIMAGELIST),
      ptr(out),
    );
    const list = Number(out[0]) as Pointer;
    if (listResult < 0 || !list) {
      failed("Windows file type image list is unavailable.");
    }
    try {
      const getIcon = bindImageListMethod(
        list,
        IMAGE_LIST_GET_ICON_SLOT,
        [
          "i32",
          "u32",
          "ptr",
        ],
        "i32",
      );
      try {
        const icon = new BigUint64Array(1);
        const result = getIcon(list, index, ILD_TRANSPARENT, ptr(icon));
        if (result < 0 || !icon[0]) {
          failed("Windows file type icon is unavailable.");
        }
        return icon[0];
      } finally {
        getIcon.close();
      }
    } finally {
      const release = bindImageListMethod(
        list,
        IMAGE_LIST_RELEASE_SLOT,
        [],
        "u32",
      );
      release(list);
      release.close();
    }
  }

  return {
    render(extension, size, signal): Pixels {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "File type icon source is closed.",
        });
      }
      assertNotCancelled(signal);
      const index = iconIndex(extension);
      const icon = extractIcon(size, index);
      try {
        assertNotCancelled(signal);
        return iconPixels(icon);
      } finally {
        user32.symbols.DestroyIcon(icon);
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      gdi32.close();
      user32.close();
      shell32.close();
    },
  };
}

function openUser32() {
  return dlopen("user32.dll", {
    ...pick(USER32, "DestroyIcon"),
    GetIconInfo: {
      args: [
        "u64",
        "ptr",
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
    GetObjectW: {
      args: [
        "u64",
        "i32",
        "ptr",
      ],
      returns: "i32",
    },
    GetDIBits: {
      args: [
        "u64",
        "u64",
        "u32",
        "u32",
        "ptr",
        "ptr",
        "u32",
      ],
      returns: "i32",
    },
    DeleteObject: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
  });
}
