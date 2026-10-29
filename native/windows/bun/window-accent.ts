import { dlopen, ptr } from "bun:ffi";
import { checkHresult } from "@bunaway/plugin/win32";
import { tryReadWindowsBuild } from "./window-corners.ts";

/** DwmSetWindowAttribute: COLORREF of the window border, honored on Windows 11 (build 22000) and later. */
const DWMWA_BORDER_COLOR = 34;
/** DwmSetWindowAttribute: COLORREF of the title bar, honored on Windows 11 (build 22000) and later. */
const DWMWA_CAPTION_COLOR = 35;
/** COLORREF value that returns the border or caption to the system color. */
const DWMWA_COLOR_DEFAULT = 0xffffffff;
/** First Windows build that knows the border and caption color attributes (Windows 11). */
const FIRST_ACCENT_BUILD = 22000;

/**
 * Whether this Windows build knows the border and caption color attributes. An unreadable
 * build is reported as Infinity, so the call is made and a failure is not hidden.
 */
export function accentSupported(build: number): boolean {
  return build >= FIRST_ACCENT_BUILD;
}

/** COLORREF (0x00BBGGRR) of a normalized `#rrggbb` color (callers validate and normalize it upstream), or the "system color" marker for null. */
export function accentColorRef(color: string | null): number {
  if (color === null) {
    return DWMWA_COLOR_DEFAULT;
  }
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return (blue << 16) | (green << 8) | red;
}

function openDwm() {
  return dlopen("dwmapi.dll", {
    DwmSetWindowAttribute: {
      args: [
        "u64",
        "u32",
        "ptr",
        "u32",
      ],
      returns: "i32",
    },
    DwmGetWindowAttribute: {
      args: [
        "u64",
        "u32",
        "ptr",
        "u32",
      ],
      returns: "i32",
    },
  });
}

/**
 * Ask DWM to paint the window border and title bar in `color` (`#rrggbb`), or return both to
 * the system color for null. A window with a custom title bar has no caption, so only its
 * border changes. A build before Windows 11 does not know the attributes, so the call is
 * skipped there without touching DWM. On a build that knows them, a failing HRESULT is
 * reported. dwmapi is opened for the call and closed before returning.
 */
export function writeWindowAccent(window: bigint, color: string | null): void {
  if (!accentSupported(tryReadWindowsBuild())) {
    return;
  }
  const library = openDwm();
  try {
    const value = Buffer.alloc(4);
    value.writeUInt32LE(accentColorRef(color) >>> 0);
    for (const attribute of [
      DWMWA_BORDER_COLOR,
      DWMWA_CAPTION_COLOR,
    ]) {
      const result = library.symbols.DwmSetWindowAttribute(
        window,
        attribute,
        ptr(value),
        value.length,
      );
      if (result < 0) {
        checkHresult(result, "DwmSetWindowAttribute");
      }
    }
  } finally {
    library.close();
  }
}

/** The COLORREFs DWM holds for the window, for verification of what the OS accepted. */
export function readWindowAccent(window: bigint): {
  border: number;
  caption: number;
} {
  const library = openDwm();
  try {
    const read = (attribute: number): number => {
      const value = Buffer.alloc(4);
      const result = library.symbols.DwmGetWindowAttribute(
        window,
        attribute,
        ptr(value),
        value.length,
      );
      if (result < 0) {
        checkHresult(result, "DwmGetWindowAttribute");
      }
      return value.readUInt32LE(0);
    };
    return {
      border: read(DWMWA_BORDER_COLOR),
      caption: read(DWMWA_CAPTION_COLOR),
    };
  } finally {
    library.close();
  }
}
