import { isBridge } from "./webview.ts";

/**
 * Reports whether this document runs in a Bunaway app WebView, as opposed to a
 * regular browser or server-side rendering.
 *
 * The check is synchronous and only looks for the host-provided message bridge
 * (`window.chrome.webview`). Hosts install it before any document script runs
 * (macOS and iOS as document-start user scripts, Android as a document-start
 * script, Windows through WebView2 itself), so the result is already `true` in
 * the first script and does not wait for `client.ready`. It returns `false`
 * without a `window` global.
 *
 * Any page can define the same global, and a Windows WebView2 host that is not
 * Bunaway also provides it. Treat the result as a UI hint only: never use it
 * to grant permissions or to prove who is calling. The backend authorizes each
 * call from its own session and policy.
 */
export function isBunaway(): boolean {
  const view = (
    globalThis as {
      window?: {
        chrome?: {
          webview?: unknown;
        };
      };
    }
  ).window;
  return isBridge(view?.chrome?.webview);
}
