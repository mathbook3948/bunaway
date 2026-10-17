import type { Pointer } from "bun:ffi";
import { checkHresult } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";
import { method, query, release } from "./com.ts";

/** Enable native CSS drag/no-drag hit testing before the first navigation.
 * The windowed controller owns region updates, DPI/zoom and document lifetime.
 * An unsupported runtime must fail custom-titlebar creation rather than leave an immovable window.
 */
export function enableCustomTitlebar(settings: Pointer): void {
  // ICoreWebView2Settings9 from the pinned WebView2 SDK; inherited setter slot 38.
  const settings9 = query(
    settings,
    "0528a73b-e92d-49f4-927a-e547dddaa37d",
    true,
  );
  if (!settings9) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message:
        "Custom titlebars require WebView2 non-client region support (1.0.2420.47 or newer).",
    });
  }
  try {
    checkHresult(
      method(settings9, 38, [
        "i32",
      ])(1),
      "Enable WebView2 custom titlebar",
    );
  } finally {
    release(settings9);
  }
}
