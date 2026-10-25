import { dlopen, ptr } from "bun:ffi";
import { checkHresult } from "@bunaway/plugin/win32";
import { tryReadWindowsBuild } from "./window-corners.ts";

/** DwmSetWindowAttribute: DWM_SYSTEMBACKDROP_TYPE, honored on Windows 11 22H2 (build 22621) and later. */
const DWMWA_SYSTEMBACKDROP_TYPE = 38;
/** HRESULT DWM returns for an attribute the running Windows does not know. */
const E_INVALIDARG = -2147024809;
/** First Windows build that knows the system backdrop attribute (Windows 11 22H2). */
const FIRST_BACKDROP_BUILD = 22621;

/** The material names of `windows.setBackgroundMaterial`, in Electron's spelling. */
export type BackgroundMaterial =
  | "auto"
  | "none"
  | "mica"
  | "acrylic"
  | "tabbed";

/** DWM_SYSTEMBACKDROP_TYPE value for each material. */
const BACKDROP_TYPE: Readonly<Record<BackgroundMaterial, number>> = {
  auto: 0,
  none: 1,
  mica: 2,
  acrylic: 3,
  tabbed: 4,
};

/**
 * Whether a failing DwmSetWindowAttribute result is the documented "no effect" case: a
 * Windows build before 22H2 rejects the unknown attribute with E_INVALIDARG. The same code
 * on a build that knows the attribute is a real rejection.
 */
export function backdropIgnored(result: number, build: number): boolean {
  return result === E_INVALIDARG && build < FIRST_BACKDROP_BUILD;
}

/**
 * Ask DWM to draw the system material behind the window frame. The material is visible
 * where the window is not covered by opaque content. dwmapi is opened for the call and
 * closed before returning; see backdropIgnored for the one failing result that is not an error.
 */
export function writeWindowBackdrop(
  window: bigint,
  material: BackgroundMaterial,
): void {
  const library = dlopen("dwmapi.dll", {
    DwmSetWindowAttribute: {
      args: [
        "u64",
        "u32",
        "ptr",
        "u32",
      ],
      returns: "i32",
    },
  });
  try {
    const value = Buffer.alloc(4);
    value.writeInt32LE(BACKDROP_TYPE[material]);
    const result = library.symbols.DwmSetWindowAttribute(
      window,
      DWMWA_SYSTEMBACKDROP_TYPE,
      ptr(value),
      value.length,
    );
    if (result < 0 && !backdropIgnored(result, tryReadWindowsBuild())) {
      checkHresult(result, "DwmSetWindowAttribute");
    }
  } finally {
    library.close();
  }
}
