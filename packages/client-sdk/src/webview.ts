import {
  type Hello,
  parseMessage,
  type Transport,
  type TransportEvent,
} from "@bunaway/protocol";

/** The message bridge exposed by a Bunaway app WebView. */
export interface WebViewBridge {
  /** Sends a protocol frame as a structured-clone value to the host. */
  postMessage(message: unknown): void;
  /** Starts receiving structured-clone messages from the host. */
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  /** Stops receiving messages with the same callback passed to `addEventListener`. */
  removeEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
}

/**
 * Adapts the WebView bridge to the protocol transport used by `createClient`.
 * Incoming values become JSON text frames; closing removes the bridge listener
 * and, after a protocol frame has been sent, notifies the host that the session ended.
 */
export function createWebViewTransport(bridge: WebViewBridge): Transport {
  const listeners = new Set<(event: TransportEvent) => void>();
  let closed = false;
  let protocol: Hello["protocol"] | undefined;
  const receive = (event: { data: unknown }) => {
    if (closed) {
      return;
    }
    // The WebView bridge supplies structured values, while Transport consumes text frames.
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
      // Parse before posting so the host receives a protocol frame, not arbitrary text.
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
      // Set closed first to ignore reentrant messages and make close idempotent.
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
