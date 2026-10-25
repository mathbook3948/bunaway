import { dlopen, ptr } from "bun:ffi";

/** DwmSetWindowAttribute: DWM_WINDOW_CORNER_PREFERENCE, honored on Windows 11 (build 22000) and later. */
const DWMWA_WINDOW_CORNER_PREFERENCE = 33;
/** Preference value: let the system decide, which rounds top-level windows on Windows 11. */
const DWMWCP_DEFAULT = 0;
/** Preference value: never round the window corners. */
const DWMWCP_DONOTROUND = 1;
/** HRESULT DWM returns for an attribute the running Windows does not know. */
const E_INVALIDARG = 0x80070057;
/** First Windows build that knows the corner preference attribute (Windows 11). */
const FIRST_CORNER_BUILD = 22000;
/** OSVERSIONINFOW is 276 bytes; dwBuildNumber follows three DWORDs and the size field. */
const OSVERSIONINFOW_SIZE = 276;
const BUILD_NUMBER_OFFSET = 12;

/**
 * Decide what a DwmSetWindowAttribute result means for the corner preference. A Windows
 * build before 11 rejects the unknown attribute with E_INVALIDARG, which is the documented
 * "no effect" case and counts as success. The same code on a build that knows the
 * attribute is a real rejection, and every other failing HRESULT is one too. Returns the
 * error to throw, or null when the call counts as done.
 */
export function cornerPreferenceFailure(
  result: number,
  build: number,
): Error | null {
  if (result >= 0) {
    return null;
  }
  if (result >>> 0 === E_INVALIDARG && build < FIRST_CORNER_BUILD) {
    return null;
  }
  return new Error(
    `DwmSetWindowAttribute failed: 0x${(result >>> 0).toString(16)}`,
  );
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

/**
 * Ask DWM to round the window corners (the system default) or keep them square. The value
 * is a hint: DWM keeps maximized and snapped windows square and skips windows that have a
 * window region or per-pixel alpha. dwmapi is opened for the call and closed before
 * returning; see cornerPreferenceFailure for which results are errors.
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
    const failure = cornerPreferenceFailure(
      result,
      result < 0 ? readWindowsBuild() : FIRST_CORNER_BUILD,
    );
    if (failure) {
      throw failure;
    }
  } finally {
    library.close();
  }
}
