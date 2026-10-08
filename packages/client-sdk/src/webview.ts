import {
  type Hello,
  parseMessage,
  type Transport,
  type TransportEvent,
} from "@bunaway/protocol";

export interface WebViewBridge {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
}

export function createWebViewTransport(bridge: WebViewBridge): Transport {
  const listeners = new Set<(event: TransportEvent) => void>();
  let closed = false;
  let protocol: Hello["protocol"] | undefined;
  const receive = (event: { data: unknown }) => {
    if (closed) {
      return;
    }
    const text = JSON.stringify(event.data);
    if (text === undefined) {
      return;
    }
    for (const listener of listeners) {
      listener({
        kind: "message",
        text,
      });
    }
  };
  bridge.addEventListener("message", receive);
  return {
    async send(text) {
      if (closed) {
        throw new Error("WebView transport closed.");
      }
      const message = parseMessage(text);
      protocol = message.protocol;
      bridge.postMessage(message);
    },
    subscribe(listener) {
      if (closed) {
        listener({
          kind: "closed",
        });
      } else {
        listeners.add(listener);
      }
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      bridge.removeEventListener("message", receive);
      try {
        if (protocol) {
          // Removing a browser listener does not close the host's session.
          bridge.postMessage({
            kind: "close",
            protocol,
          });
        }
      } finally {
        for (const listener of listeners) {
          listener({
            kind: "closed",
          });
        }
        listeners.clear();
      }
    },
  };
}
