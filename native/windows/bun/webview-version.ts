import { dlopen, type Pointer, ptr } from "bun:ffi";
import { OLE32, pick } from "@bunaway/plugin/win32";
import { readWideString } from "./wide-string.ts";

/** Longest WebView2 version string accepted, in bytes (128 UTF-16 units). */
const MAX_VERSION_BYTES = 256;

/**
 * Asks WebView2Loader for the installed WebView2 runtime version, such as
 * `120.0.2210.91`. Uses the same default browser location as WebView creation
 * (no explicit executable folder). Opens and closes its own library handles,
 * so it is safe to call before any WebView exists.
 *
 * Throws when the loader cannot be opened, reports a failed HRESULT (for
 * example no installed runtime), or returns no usable string. The caller
 * decides how to report that, since a missing version is not fatal.
 */
export function readWebViewVersion(loaderPath: string): string {
  const ole = dlopen("ole32.dll", {
    ...pick(OLE32, "CoTaskMemFree"),
  });
  const out = new BigUint64Array(1);
  try {
    const loader = dlopen(loaderPath, {
      GetAvailableCoreWebView2BrowserVersionString: {
        args: [
          "ptr",
          "ptr",
        ],
        returns: "i32",
      },
    });
    try {
      const result =
        loader.symbols.GetAvailableCoreWebView2BrowserVersionString(
          null,
          ptr(out),
        );
      if (result < 0) {
        throw new Error(
          `GetAvailableCoreWebView2BrowserVersionString: 0x${(result >>> 0).toString(16)}`,
        );
      }
    } finally {
      loader.close();
    }
    if (!out[0]) {
      throw new Error("WebView2 runtime version is unavailable.");
    }
    const version = readWideString(
      Number(out[0]) as Pointer,
      MAX_VERSION_BYTES,
    );
    if (!version) {
      throw new Error("WebView2 runtime version is empty or oversized.");
    }
    return version;
  } finally {
    if (out[0]) {
      ole.symbols.CoTaskMemFree(Number(out[0]) as Pointer);
    }
    ole.close();
  }
}
