import { BunawayError, PROTOCOL_VERSION } from "@bunaway/protocol";
import type { Client, ClientFactory } from "./index.ts";
import { createWebViewTransport, type WebViewBridge } from "./webview.ts";

// Store the session on the window so UI hot updates and repeated SDK imports
// cannot send a second hello or reuse request IDs in the same document.
const sessionKey = Symbol.for("@bunaway/client.default-session.v1");

interface WebViewWindow {
  readonly document: object;
  readonly chrome?: { readonly webview?: WebViewBridge };
  addEventListener(type: "pagehide", listener: () => void): void;
  removeEventListener(type: "pagehide", listener: () => void): void;
  [sessionKey]?: { document: object; client: Client };
}

export function defaultClient(factory: ClientFactory): Client {
  const view = (globalThis as { window?: WebViewWindow }).window;
  if (!view) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message:
        "Bunaway client requires an app WebView. Use createClient({ transport, hello }) for a custom connection.",
    });
  }
  const previous = view[sessionKey];
  if (previous?.document === view.document) return previous.client;

  const bridge = view.chrome?.webview;
  if (
    !bridge ||
    typeof bridge.postMessage !== "function" ||
    typeof bridge.addEventListener !== "function" ||
    typeof bridge.removeEventListener !== "function"
  ) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message:
        "Bunaway bridge is unavailable. Open this page through bunaway dev or the desktop app.",
    });
  }

  void previous?.client.close();
  const transport = createWebViewTransport(bridge);
  let client: Client | undefined;
  const onPageHide = () => {
    void client?.close();
  };
  view.addEventListener("pagehide", onPageHide);
  const created = factory({
    transport: {
      ...transport,
      async close() {
        view.removeEventListener("pagehide", onPageHide);
        await transport.close();
      },
    },
    hello: {
      kind: "hello",
      protocol: PROTOCOL_VERSION,
      features: [],
      buildId: "bunaway-client",
    },
  });
  client = created;
  view[sessionKey] = { document: view.document, client: created };
  return created;
}
