/**
 * Oldest WebView2 runtime the host starts with. Window creation and the request and permission
 * handlers query these interfaces without a fallback: `ICoreWebView2_4` (download policy),
 * `ICoreWebView2Settings4`, `ICoreWebView2_3` (virtual host mapping outside embedded mode),
 * `ICoreWebView2Controller2` (background color), `ICoreWebView2Environment8` (browser process
 * exit subscription and process list), `ICoreWebView2PermissionRequestedEventArgs3` (permission denial) and, for embedded
 * assets, `ICoreWebView2_22` (resource filters by request source). A runtime older than the one
 * that introduced the newest of them fails later with an unrelated QueryInterface error, so the
 * value follows the newest (`ICoreWebView2_22`). Interfaces the host treats as optional, such as
 * `ICoreWebView2Settings9`, and ones queried only when the app calls the matching API, such as
 * `ICoreWebView2_8` audio state, do not raise this value.
 */
export const MIN_WEBVIEW_RUNTIME_VERSION = "128.0.2739.15";

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
  for (const [index, part] of actual.entries()) {
    const floor = required[index] ?? 0;
    if (part !== floor) {
      return part < floor;
    }
  }
  return false;
}

/** Startup error for a runtime below the minimum; names versions only, never a path. */
export function webViewVersionTooOldMessage(version: string): string {
  return `WebView2 runtime ${version} is older than the required ${MIN_WEBVIEW_RUNTIME_VERSION}. Install or update the Microsoft Edge WebView2 Runtime (Evergreen) and start the app again.`;
}

/** What the startup version check found: the value for `app.webview`, a log entry and, below the minimum, the startup failure. */
export interface WebViewVersionCheck {
  version: string | null;
  event?: {
    name: string;
    fields: Record<string, string>;
  };
  failure?: Error;
}

/**
 * Classifies the runtime version `read` returns. A failed read or an unparsable version leaves
 * startup running (with the version as null or as read); a version below the minimum carries the
 * startup failure. The caller logs the event and throws the failure.
 */
export function checkWebViewVersion(read: () => string): WebViewVersionCheck {
  let version: string;
  try {
    version = read();
  } catch (cause) {
    return {
      version: null,
      event: {
        name: "webview-version-unavailable",
        fields: {
          message: cause instanceof Error ? cause.message : String(cause),
        },
      },
    };
  }
  if (isWebViewVersionTooOld(version)) {
    return {
      version,
      event: {
        name: "webview-version-too-old",
        fields: {
          version,
        },
      },
      failure: new Error(webViewVersionTooOldMessage(version)),
    };
  }
  if (!parseWebViewVersion(version)) {
    return {
      version,
      event: {
        name: "webview-version-unparsable",
        fields: {
          version,
        },
      },
    };
  }
  return {
    version,
  };
}
