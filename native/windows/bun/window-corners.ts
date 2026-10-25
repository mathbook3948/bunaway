import { dlopen, ptr } from "bun:ffi";

/** DwmSetWindowAttribute: DWM_WINDOW_CORNER_PREFERENCE, honored on Windows 11 (build 22000) and later. */
const DWMWA_WINDOW_CORNER_PREFERENCE = 33;
/** Preference value: let the system decide, which rounds top-level windows on Windows 11. */
const DWMWCP_DEFAULT = 0;
/** Preference value: never round the window corners. */
const DWMWCP_DONOTROUND = 1;
/** HRESULT DWM returns for an attribute the running Windows does not know. */
const E_INVALIDARG = 0x80070057;

/**
 * Ask DWM to round the window corners (the system default) or keep them square. The value
 * is a hint: DWM keeps maximized and snapped windows square and skips windows that have a
 * window region or per-pixel alpha. Windows before 11 reject the attribute with
 * E_INVALIDARG, which is the documented "no effect" case and is not an error. Any other
 * failing HRESULT is thrown. dwmapi is opened for the call and closed before returning.
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
    if (result >>> 0 === E_INVALIDARG) {
      return;
    }
    if (result < 0) {
      throw new Error(
        `DwmSetWindowAttribute failed: 0x${(result >>> 0).toString(16)}`,
      );
    }
  } finally {
    library.close();
  }
}
