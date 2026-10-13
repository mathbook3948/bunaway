import { dlopen } from "bun:ffi";
import { BunawayError } from "@bunaway/protocol";
import { trayIconImage } from "./tray-icon-data.ts";
import { withBuffer } from "./windows-buffers.ts";

/** Create an owned HICON. The caller must DestroyIcon after replacement or final cleanup. */
export function createTrayIcon(ico: string): bigint {
  // RT_ICON bits must be DWORD-aligned; copy the ICO frame out of its directory offset.
  const image = Buffer.from(trayIconImage(ico));
  const native = dlopen("user32.dll", {
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
  });
  try {
    const icon = withBuffer(image, (address) =>
      native.symbols.CreateIconFromResourceEx(
        address,
        image.length,
        1,
        0x00030000,
        0,
        0,
        0,
      ),
    );
    if (!icon) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Windows rejected the tray ICO image.",
      });
    }
    return icon;
  } finally {
    native.close();
  }
}
