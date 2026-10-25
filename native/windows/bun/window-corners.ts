import { dlopen, ptr } from "bun:ffi";
import { checkHresult } from "@bunaway/plugin/win32";

/** DwmSetWindowAttribute: DWM_WINDOW_CORNER_PREFERENCE, honored on Windows 11 (build 22000) and later. */
const DWMWA_WINDOW_CORNER_PREFERENCE = 33;
/** Preference value: let the system decide, which rounds top-level windows on Windows 11. */
const DWMWCP_DEFAULT = 0;
/** Preference value: never round the window corners. */
const DWMWCP_DONOTROUND = 1;
/** HRESULT DWM returns for an attribute the running Windows does not know. */
const E_INVALIDARG = -2147024809;
/** First Windows build that knows the corner preference attribute (Windows 11). */
const FIRST_CORNER_BUILD = 22000;
/** OSVERSIONINFOW is 276 bytes; dwBuildNumber follows three DWORDs and the size field. */
const OSVERSIONINFOW_SIZE = 276;
const BUILD_NUMBER_OFFSET = 12;

/**
 * Whether a failing DwmSetWindowAttribute result is the documented "no effect" case: a
 * Windows build before 11 rejects the unknown attribute with E_INVALIDARG. The same code
 * on a build that knows the attribute is a real rejection.
 */
export function cornerPreferenceIgnored(
  result: number,
  build: number,
): boolean {
  return result === E_INVALIDARG && build < FIRST_CORNER_BUILD;
}

/** The running Windows build number from RtlGetVersion, which is not subject to manifest version lies. */
function readWindowsBuild(): number {
  const library = dlopen("ntdll.dll", {
    RtlGetVersion: {
      args: [
        "ptr",
      ],
      returns: "i32",
    },
  });
  try {
    const info = Buffer.alloc(OSVERSIONINFOW_SIZE);
    info.writeUInt32LE(OSVERSIONINFOW_SIZE, 0);
    const status = library.symbols.RtlGetVersion(ptr(info));
    if (status < 0) {
      throw new Error(`RtlGetVersion failed: 0x${(status >>> 0).toString(16)}`);
    }
    return info.readUInt32LE(BUILD_NUMBER_OFFSET);
  } finally {
    library.close();
  }
}

/** The build number, or Infinity when it cannot be read so the original HRESULT is reported. */
function tryReadWindowsBuild(): number {
  try {
    return readWindowsBuild();
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Ask DWM to round the window corners (the system default) or keep them square. The value
 * is a hint that DWM may not honor, for example for maximized or snapped windows. dwmapi is opened for the call and closed before
 * returning; see cornerPreferenceIgnored for the one failing result that is not an error.
 */
export function writeWindowCornerPreference(
  window: bigint,
  rounded: boolean,
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
    value.writeInt32LE(rounded ? DWMWCP_DEFAULT : DWMWCP_DONOTROUND);
    const result = library.symbols.DwmSetWindowAttribute(
      window,
      DWMWA_WINDOW_CORNER_PREFERENCE,
      ptr(value),
      value.length,
    );
    if (result < 0 && !cornerPreferenceIgnored(result, tryReadWindowsBuild())) {
      checkHresult(result, "DwmSetWindowAttribute");
    }
  } finally {
    library.close();
  }
}
