import {
  type Hello,
  parseMessage,
  type Transport,
  type TransportEvent,
} from "@bunaway/protocol";

// Android's host-owned adapter can carry text without a structured-value round trip.
const textBridgeKey = Symbol.for("@bunaway/webview.text.v1");

function isBridge(value: unknown): value is WebViewBridge {
  return (
    typeof value === "object" &&
    value !== null &&
    "postMessage" in value &&
    typeof value.postMessage === "function" &&
    "addEventListener" in value &&
    typeof value.addEventListener === "function" &&
    "removeEventListener" in value &&
    typeof value.removeEventListener === "function"
  );
}

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
  const candidate: unknown = Reflect.get(bridge, textBridgeKey);
  const textMode = isBridge(candidate);
  const channel = textMode ? candidate : bridge;
  const listeners = new Set<(event: TransportEvent) => void>();
  let closed = false;
  let protocol: Hello["protocol"] | undefined;
  const receive = (event: { data: unknown }) => {
    if (closed) {
      return;
    }
    const text = textMode ? event.data : JSON.stringify(event.data);
    if (typeof text !== "string") {
      return;
    }
    for (const listener of listeners) {
      listener({
        kind: "message",
        text,
      });
    }
  };
  channel.addEventListener("message", receive);
  let releaseClosed: (() => void) | undefined;
  const finish = () => {
    channel.removeEventListener("message", receive);
    releaseClosed?.();
    for (const listener of listeners) {
      listener({
        kind: "closed",
      });
    }
    listeners.clear();
  };
  if (
    textMode &&
    "subscribeClosed" in channel &&
    typeof channel.subscribeClosed === "function"
  ) {
    const release: unknown = channel.subscribeClosed(() => {
      if (closed) {
        return;
      }
      closed = true;
      finish();
    });
    if (typeof release !== "function") {
      channel.removeEventListener("message", receive);
      throw new Error("Invalid WebView close subscription.");
    }
    releaseClosed = () => release();
    if (closed) {
      releaseClosed();
    }
  }
  return {
    async send(text) {
      if (closed) {
        throw new Error("WebView transport closed.");
      }
      // Parse before posting so the host receives a protocol frame, not arbitrary text.
      const message = parseMessage(text);
      protocol = message.protocol;
      channel.postMessage(textMode ? text : message);
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
      try {
        if (protocol) {
          // Removing a browser listener does not close the host's session.
          const message = {
            kind: "close",
            protocol,
          };
          channel.postMessage(textMode ? JSON.stringify(message) : message);
        }
      } finally {
        finish();
      }
    },
  };
}
