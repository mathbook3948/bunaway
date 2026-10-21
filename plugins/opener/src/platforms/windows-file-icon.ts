import { dlopen, ptr } from "bun:ffi";
import { ResourceOwner } from "@bunaway/plugin";
import {
  GDI32,
  pick,
  SHELL32,
  USER32,
  withBuffer,
  withWide,
} from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";
import { type FileIconSize, MAX_FILE_ICON_EDGE_PIXELS } from "#opener/contract";
import {
  hasAlphaChannel,
  type IconPixels,
  toRgba,
} from "#opener/platforms/icon-pixels";
import { ComScope } from "#opener/platforms/windows-com";

/** What to look up: an existing file's own icon, or the icon registered for an extension. */
export type FileIconTarget =
  | {
      path: string;
    }
  | {
      extension: string;
    };

const FILE_ATTRIBUTE_NORMAL = 0x80;
const SHGFI_SYSICONINDEX = 0x4000;
const SHGFI_USEFILEATTRIBUTES = 0x10;
const SHFILEINFOW_BYTES = 696;
const SHFILEINFO_ICON_INDEX_OFFSET = 8;
/** Shell image list sizes: SHIL_LARGE is 32, SHIL_SMALL 16 and SHIL_EXTRALARGE 48 pixels at 100% scale. */
const SHIL_BY_SIZE: Record<FileIconSize, number> = {
  small: 1,
  normal: 0,
  large: 2,
};
const ILD_TRANSPARENT = 0x1;
/** `IImageList::GetIcon`, counting the three `IUnknown` methods. */
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
const BITS_PER_PIXEL = 32;

function failed(message: string): never {
  throw new BunawayError({
    code: "INTERNAL",
    message,
  });
}

/**
 * Bind the Shell, user32 and gdi32 functions that turn the Shell's icon for a file or extension
 * into pixels. Everything one request acquires (the image list, the icon, its two bitmaps and the
 * screen DC) is released when the request ends, whether it succeeds or fails; `dispose` closes the
 * libraries and is safe to repeat. Calls must run on the opener's STA thread.
 */
export function createFileIcons() {
  const owner = new ResourceOwner("Opener file icon cleanup failed.");
  const shell32 = owner.acquire(
    () =>
      dlopen("shell32.dll", pick(SHELL32, "SHGetFileInfoW", "SHGetImageList")),
    (library) => library.close(),
  );
  const user32 = owner.acquire(
    () =>
      dlopen(
        "user32.dll",
        pick(USER32, "DestroyIcon", "GetDC", "GetIconInfo", "ReleaseDC"),
      ),
    (library) => library.close(),
  );
  const gdi32 = owner.acquire(
    () =>
      dlopen(
        "gdi32.dll",
        pick(GDI32, "DeleteObject", "GetDIBits", "GetObjectW"),
      ),
    (library) => library.close(),
  );

  /** Index of the target's icon in the system image list. A path is looked up on disk; an extension is not. */
  function iconIndex(target: FileIconTarget): number {
    const [name, attributes, flags] =
      "path" in target
        ? ([
            target.path,
            0,
            SHGFI_SYSICONINDEX,
          ] as const)
        : ([
            `file${target.extension}`,
            FILE_ATTRIBUTE_NORMAL,
            SHGFI_SYSICONINDEX | SHGFI_USEFILEATTRIBUTES,
          ] as const);
    const fileInfo = Buffer.alloc(SHFILEINFOW_BYTES);
    const result = withWide(name, (nameAddress) =>
      withBuffer(fileInfo, (infoAddress) =>
        shell32.symbols.SHGetFileInfoW(
          nameAddress,
          attributes,
          infoAddress,
          SHFILEINFOW_BYTES,
          flags,
        ),
      ),
    );
    if (!result) {
      failed("Windows file icon lookup failed.");
    }
    return fileInfo.readInt32LE(SHFILEINFO_ICON_INDEX_OFFSET);
  }

  /** Read one bitmap's top-down 32 bits per pixel as BGRA through the screen DC. */
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
    header.writeUInt16LE(BITS_PER_PIXEL, 14);
    header.writeUInt32LE(BI_RGB, 16);
    const bits = Buffer.alloc(width * height * BYTES_PER_PIXEL);
    const lines = withBuffer(bits, (bitsAddress) =>
      withBuffer(header, (headerAddress) =>
        gdi32.symbols.GetDIBits(
          screen,
          bitmap,
          0,
          height,
          bitsAddress,
          headerAddress,
          DIB_RGB_COLORS,
        ),
      ),
    );
    if (lines !== height) {
      failed("Windows file icon bitmap could not be read.");
    }
    return bits;
  }

  /** Convert an HICON to RGBA. The bitmaps `GetIconInfo` creates and the DC are released before returning. */
  function iconPixels(icon: bigint): IconPixels {
    const request = new ResourceOwner("Opener file icon cleanup failed.");
    try {
      const info = Buffer.alloc(ICONINFO_BYTES);
      if (
        !withBuffer(info, (address) =>
          user32.symbols.GetIconInfo(icon, address),
        )
      ) {
        failed("Windows file icon information is unavailable.");
      }
      const mask = info.readBigUInt64LE(ICONINFO_MASK_OFFSET);
      const color = info.readBigUInt64LE(ICONINFO_COLOR_OFFSET);
      for (const bitmap of [
        mask,
        color,
      ]) {
        request.acquire(
          () => bitmap,
          (handle) => {
            if (handle) {
              gdi32.symbols.DeleteObject(handle);
            }
          },
        );
      }
      if (!color) {
        failed("Windows file icon has no color bitmap.");
      }
      const object = Buffer.alloc(BITMAP_BYTES);
      if (
        !withBuffer(object, (address) =>
          gdi32.symbols.GetObjectW(color, BITMAP_BYTES, address),
        )
      ) {
        failed("Windows file icon size is unavailable.");
      }
      const width = object.readInt32LE(BITMAP_WIDTH_OFFSET);
      const height = object.readInt32LE(BITMAP_HEIGHT_OFFSET);
      if (
        width <= 0 ||
        height <= 0 ||
        width > MAX_FILE_ICON_EDGE_PIXELS ||
        height > MAX_FILE_ICON_EDGE_PIXELS
      ) {
        failed("Windows file icon size is unsupported.");
      }
      const screen = request.acquire(
        () => user32.symbols.GetDC(0n),
        (context) => {
          if (context) {
            user32.symbols.ReleaseDC(0n, context);
          }
        },
      );
      if (!screen) {
        failed("Windows screen device context is unavailable.");
      }
      const bgra = readBitmap(screen, color, width, height);
      // Only an icon without an alpha channel needs its mask to tell the transparent pixels.
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
      request.dispose();
    }
  }

  /** Fetch the icon at `index` from the Shell image list of the requested size, as an owned HICON. */
  function extractIcon(
    scope: ComScope,
    size: FileIconSize,
    index: number,
  ): bigint {
    const list = scope.acquire((out) =>
      withBuffer(IID_IIMAGELIST, (iid) =>
        shell32.symbols.SHGetImageList(SHIL_BY_SIZE[size], iid, out),
      ),
    );
    const getIcon = scope.call(list, IMAGE_LIST_GET_ICON_SLOT, [
      "i32",
      "u32",
      "ptr",
    ]);
    const icon = new BigUint64Array(1);
    if (getIcon(index, ILD_TRANSPARENT, ptr(icon)) < 0 || !icon[0]) {
      failed("Windows file icon is unavailable.");
    }
    return icon[0];
  }

  return {
    /**
     * Rasterize the icon of `target` at `size`. Throws `INTERNAL` when the Shell cannot produce
     * it and `CANCELLED` after `dispose`. The call is synchronous: a path on a slow or
     * disconnected volume can block until the Shell gives up.
     */
    render(target: FileIconTarget, size: FileIconSize): IconPixels {
      if (owner.disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Opener has been disposed.",
        });
      }
      const index = iconIndex(target);
      const request = new ResourceOwner("Opener file icon cleanup failed.");
      try {
        const scope = request.acquire(
          () =>
            new ComScope(
              () =>
                new BunawayError({
                  code: "INTERNAL",
                  message: "Windows file icon image list is unavailable.",
                }),
            ),
          (resource) => resource.release(),
        );
        const icon = request.acquire(
          () => extractIcon(scope, size, index),
          (handle) => user32.symbols.DestroyIcon(handle),
        );
        return iconPixels(icon);
      } finally {
        request.dispose();
      }
    },
    /** Close the libraries after the opener's last lookup. Repeated calls are safe. */
    dispose(): void {
      owner.dispose();
    },
  };
}
