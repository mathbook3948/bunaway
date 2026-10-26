/**
 * Oldest WebView2 runtime the host starts with. The host queries `ICoreWebView2_4` (download
 * policy), `ICoreWebView2_8` (audio state) and `ICoreWebView2Controller2` (background color)
 * without a fallback, so a runtime older than the one that introduced the newest of them fails
 * later with an unrelated QueryInterface error. Interfaces the host treats as optional, such as
 * `ICoreWebView2Settings9`, do not raise this value.
 */
export const MIN_WEBVIEW_RUNTIME_VERSION = "97.0.1072.54";

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)\.(\d+)(?: .+)?$/;

/** The four numeric parts of a runtime version such as `120.0.2210.91`, or null when it has another shape. */
export function parseWebViewVersion(version: string): number[] | null {
  const match = VERSION_PATTERN.exec(version);
  if (!match) {
    return null;
  }
  return match.slice(1, 5).map(Number);
}

/**
 * Whether `version` is older than {@link MIN_WEBVIEW_RUNTIME_VERSION}. A version that does not
 * parse is not reported as old: it is treated like an unreadable version, which does not stop startup.
 */
export function isWebViewVersionTooOld(
  version: string,
  minimum: string = MIN_WEBVIEW_RUNTIME_VERSION,
): boolean {
  const actual = parseWebViewVersion(version);
  const required = parseWebViewVersion(minimum);
  if (!actual || !required) {
    return false;
  }
  for (let index = 0; index < 4; index++) {
    if (actual[index] !== required[index]) {
      return actual[index] < required[index];
    }
  }
  return false;
}

/** Startup error for a runtime below the minimum; names versions only, never a path. */
export function webViewVersionTooOldMessage(version: string): string {
  return `WebView2 runtime ${version} is older than the required ${MIN_WEBVIEW_RUNTIME_VERSION}. Install or update the Microsoft Edge WebView2 Runtime (Evergreen) and start the app again.`;
}
