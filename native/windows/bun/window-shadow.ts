import { dlopen, ptr } from "bun:ffi";

const DWMWA_NCRENDERING_ENABLED = 1;
const DWMWA_NCRENDERING_POLICY = 2;
const DWMNCRP_USEWINDOWSTYLE = 0;
const DWMNCRP_DISABLED = 1;

/**
 * Read whether DWM currently renders the window's non-client frame. The frame carries the
 * window shadow and the policy attribute can only be written, so the live enabled flag is
 * the state: a window whose policy was never changed has a shadow. dwmapi is opened for the
 * call and closed before returning, and the 4-byte buffer never outlives it.
 */
export function readWindowShadow(window: bigint): boolean {
  const library = dlopen("dwmapi.dll", {
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
  try {
    const value = Buffer.alloc(4);
    const result = library.symbols.DwmGetWindowAttribute(
      window,
      DWMWA_NCRENDERING_ENABLED,
      ptr(value),
      value.length,
    );
    if (result < 0) {
      throw new Error(`DwmGetWindowAttribute: ${result >>> 0}`);
    }
    return value.readInt32LE(0) !== 0;
  } finally {
    library.close();
  }
}

/** Turn the DWM-drawn shadow off, or back to the window-style default. */
export function writeWindowShadow(window: bigint, shadow: boolean): void {
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
    value.writeInt32LE(shadow ? DWMNCRP_USEWINDOWSTYLE : DWMNCRP_DISABLED);
    const result = library.symbols.DwmSetWindowAttribute(
      window,
      DWMWA_NCRENDERING_POLICY,
      ptr(value),
      value.length,
    );
    if (result < 0) {
      throw new Error(`DwmSetWindowAttribute: ${result >>> 0}`);
    }
  } finally {
    library.close();
  }
}
