import type { Transport, TransportEvent } from "@bunaway/protocol";

export interface WebViewBridge {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export function createWebViewTransport(bridge: WebViewBridge): Transport {
  const listeners = new Set<(event: TransportEvent) => void>();
  let closed = false;
  const receive = (event: { data: unknown }) => {
    const text = JSON.stringify(event.data);
    if (text === undefined) return;
    for (const listener of listeners) listener({ kind: "message", text });
  };
  bridge.addEventListener("message", receive);
  return {
    async send(text) {
      if (closed) throw new Error("WebView transport closed.");
      bridge.postMessage(JSON.parse(text));
    },
    subscribe(listener) {
      if (closed) listener({ kind: "closed" });
      else listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      bridge.removeEventListener("message", receive);
      for (const listener of listeners) listener({ kind: "closed" });
      listeners.clear();
    },
  };
}
