import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { checkHresult, GDI32, pick } from "@bunaway/plugin/win32";

/** DWM_BLURBEHIND.dwFlags: fEnable and hRgnBlur are valid. */
const DWM_BB_ENABLE = 0x1;
const DWM_BB_BLURREGION = 0x2;
/** DWM_BLURBEHIND is a DWORD, a BOOL, an HRGN (8-byte aligned) and a BOOL. */
const DWM_BLURBEHIND_SIZE = 24;
const BLURREGION_OFFSET = 8;

/**
 * Let the alpha channel of the window's drawing surface take part in desktop composition.
 *
 * A top-level window composes as opaque even when its WebView2 child clears to alpha 0. Enabling
 * blur-behind with an empty region makes DWM honor the surface alpha without blurring anything,
 * so the transparent parts of the page show the desktop. The setting belongs to the window and
 * ends with it. The empty region is released before returning, and gdi32 and dwmapi are opened
 * for the call and closed before returning.
 */
export function enableWindowTransparency(window: bigint): void {
  const gdi = dlopen("gdi32.dll", pick(GDI32, "CreateRectRgn", "DeleteObject"));
  try {
    const dwm = dlopen("dwmapi.dll", {
      DwmEnableBlurBehindWindow: {
        args: [
          "u64",
          "ptr",
        ],
        returns: "i32",
      },
    });
    try {
      // A region with no area (right and bottom before left and top) blurs nothing.
      const region = gdi.symbols.CreateRectRgn(0, 0, -1, -1);
      assert(region, "CreateRectRgn failed.");
      try {
        const blur = Buffer.alloc(DWM_BLURBEHIND_SIZE);
        blur.writeUInt32LE(DWM_BB_ENABLE | DWM_BB_BLURREGION, 0);
        blur.writeInt32LE(1, 4);
        blur.writeBigUInt64LE(region, BLURREGION_OFFSET);
        checkHresult(
          dwm.symbols.DwmEnableBlurBehindWindow(window, ptr(blur)),
          "DwmEnableBlurBehindWindow",
        );
      } finally {
        gdi.symbols.DeleteObject(region);
      }
    } finally {
      dwm.close();
    }
  } finally {
    gdi.close();
  }
}
