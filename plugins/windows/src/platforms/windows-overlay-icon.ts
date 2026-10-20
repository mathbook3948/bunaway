import { dlopen, ptr } from "bun:ffi";
import {
  type NativeOverlayIconProvider,
  parseNativeIco,
  selectNativeIcoFrame,
} from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";

// CreateIconFromResourceEx arguments: fIcon = TRUE for an icon rather than a cursor, the resource
// format version accepted for icon data, and no LR_* flags.
const ICON_RESOURCE_IS_ICON = 1;
const ICON_RESOURCE_VERSION = 0x00030000;
const NO_ICON_FLAGS = 0;

function openCreateIcon() {
  return dlopen("user32.dll", {
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
  }).symbols.CreateIconFromResourceEx;
}

/** Process-lifetime user32 binding, opened on first use so importing this module loads no DLL. */
let createIconFromResource: ReturnType<typeof openCreateIcon> | undefined;

/**
 * Validate a base64 ICO and return a provider that builds an owned HICON from it at a requested pixel
 * size. Validation happens here, before any native call, so a malformed ICO is INVALID_ARGUMENT and
 * leaves the current overlay untouched. Each provider call returns a new HICON whose owner must
 * `DestroyIcon` it; a frame Windows rejects throws INVALID_ARGUMENT.
 */
export function overlayIconProvider(
  ico: string,
  subject: "overlay" | "window" = "overlay",
): NativeOverlayIconProvider {
  const frames = parseNativeIco(ico);
  if (!frames) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: `Invalid ${subject} ICO image.`,
    });
  }
  return (sizePx) => {
    const frame = selectNativeIcoFrame(frames, sizePx);
    if (!frame) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: `Invalid ${subject} ICO image.`,
      });
    }
    // RT_ICON bits must be DWORD-aligned, so copy the frame out of the ICO payload.
    const image = Buffer.from(frame.data);
    createIconFromResource ??= openCreateIcon();
    // `image` stays referenced by this frame until the synchronous call returns.
    const icon = createIconFromResource(
      ptr(image),
      image.length,
      ICON_RESOURCE_IS_ICON,
      ICON_RESOURCE_VERSION,
      sizePx,
      sizePx,
      NO_ICON_FLAGS,
    );
    if (!icon) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: `Windows rejected the ${subject} ICO image.`,
      });
    }
    return icon;
  };
}
