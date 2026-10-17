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
 * That ordering follows from how each host installs the bridge; only the
 * Windows host regression observes the result, and only from an end-of-body script.
 *
 * Child frames differ by platform. Windows WebView2 and macOS expose the bridge
 * to every frame, so the result is `true`; iOS is `false`; Android is `true` in
 * same-origin child frames. Even then the host does not receive child-frame
 * messages, so `true` does not mean the bridge is usable there.
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
