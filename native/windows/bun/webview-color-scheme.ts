import type { Pointer } from "bun:ffi";
import { checkHresult } from "@bunaway/plugin/win32";
import type { NativeContentColorScheme } from "@bunaway/plugin-api/native";
import { getObject, method, query, release } from "./com.ts";

/** COREWEBVIEW2_PREFERRED_COLOR_SCHEME from the pinned WebView2 SDK. */
const PREFERRED_COLOR_SCHEME: Record<NativeContentColorScheme, number> = {
  auto: 0,
  light: 1,
  dark: 2,
};
/** ICoreWebView2_13 slot of get_Profile (ICoreWebView2_12 ends with get_StatusBarText at 104). */
const GET_PROFILE_SLOT = 105;
/** ICoreWebView2Profile slot of put_PreferredColorScheme. */
const PUT_PREFERRED_COLOR_SCHEME_SLOT = 9;

/**
 * Set the profile's `prefers-color-scheme` through ICoreWebView2_13 and ICoreWebView2Profile
 * (pinned SDK 1.0.4129.50). The profile is shared by every controller of the same user data
 * folder, so the last value wins for all of them. Returns false when the runtime predates the
 * interfaces; any other failure throws. Both temporary interfaces are released before returning.
 */
export function setProfileColorScheme(
  webview: Pointer,
  scheme: NativeContentColorScheme,
): boolean {
  const webview13 = query(
    webview,
    "f75f09a8-667e-4983-88d6-c8773f315e84",
    true,
  );
  if (!webview13) {
    return false;
  }
  try {
    const profile = getObject(webview13, GET_PROFILE_SLOT);
    try {
      checkHresult(
        method(profile, PUT_PREFERRED_COLOR_SCHEME_SLOT, [
          "i32",
        ])(PREFERRED_COLOR_SCHEME[scheme]),
        "put_PreferredColorScheme",
      );
    } finally {
      release(profile);
    }
    return true;
  } finally {
    release(webview13);
  }
}
