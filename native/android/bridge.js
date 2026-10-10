// The Android origin-matched native object exists before app scripts run.
(() => {
  if (window !== window.top || !globalThis.bunawayNative) {
    return;
  }
  const listeners = new Set();
  const textListeners = new Set();
  const closeListeners = new Set();
  let active = true;
  const portPrefix = "__BUNAWAY_PORT_PREFIX__";
  const nonce = crypto.randomUUID();
  const portRequest = portPrefix + nonce;
  const queued = [];
  let connecting = true;
  let port;
  let socket;
  const post = (text) => {
    if (socket) {
      const remaining =
        __BUNAWAY_MAX_MESSAGE_BYTES__ * 2 - socket.bufferedAmount;
      if (
        text.length * 3 > remaining &&
        new TextEncoder().encode(text).byteLength > remaining
      ) {
        closeBridge();
        throw new Error("Bridge output queue full");
      }
      socket.send(text);
    } else if (port) {
      port.postMessage(text);
    } else {
      bunawayNative.postMessage(text);
    }
  };
  const connected = () => {
    connecting = false;
    try {
      for (const text of queued) {
        post(text);
      }
      queued.length = 0;
    } catch {
      // A failed setup flush closes pending SDK calls instead of leaving them waiting.
      closeBridge();
    }
  };
  const acceptPort = (event) => {
    if (typeof event.data !== "string" || !event.data.startsWith(portPrefix)) {
      return;
    }
    const endpoint = event.ports?.[0];
    if (!endpoint) {
      return;
    }
    if (
      !active ||
      socket ||
      !connecting ||
      event.data !== portRequest ||
      event.ports.length !== 1
    ) {
      for (const stale of event.ports) {
        stale.close();
      }
      return;
    }
    port = endpoint;
    port.onmessage = (message) => bunawayNative.onmessage(message);
    connected();
  };
  addEventListener("message", acceptPort);
  const closeBridge = () => {
    if (!active) {
      return;
    }
    active = false;
    removeEventListener("message", acceptPort);
    socket?.close();
    port?.close();
    queued.length = 0;
    for (const listener of closeListeners) {
      listener();
    }
    closeListeners.clear();
    listeners.clear();
    textListeners.clear();
  };
  const textBridge = {
    subscribeClosed(listener) {
      if (active) {
        closeListeners.add(listener);
      } else {
        listener();
      }
      return () => closeListeners.delete(listener);
    },
    postMessage(text) {
      if (!active) {
        throw new Error("Bunaway document closed");
      }
      if (typeof text !== "string") {
        throw new TypeError("Text message required");
      }
      if (text.length > __BUNAWAY_MAX_MESSAGE_BYTES__) {
        throw new Error("Message too large");
      }
      if (connecting && queued.length >= __BUNAWAY_MAX_PENDING__) {
        throw new Error("Bridge connection queue full");
      }
      if (connecting) {
        queued.push(text);
      } else {
        post(text);
      }
    },
    addEventListener(type, listener) {
      if (type === "message") {
        textListeners.add(listener);
      }
    },
    removeEventListener(type, listener) {
      if (type === "message") {
        textListeners.delete(listener);
      }
    },
  };
  const bridge = {
    postMessage(message) {
      textBridge.postMessage(JSON.stringify(message));
    },
    addEventListener(type, listener) {
      if (type === "message") {
        listeners.add(listener);
      }
    },
    removeEventListener(type, listener) {
      if (type === "message") {
        listeners.delete(listener);
      }
    },
  };
  Object.defineProperty(bridge, Symbol.for("@bunaway/webview.text.v1"), {
    value: textBridge,
  });
  bunawayNative.onmessage = (event) => {
    if (!active) {
      return;
    }
    if (connecting && event.data === `${portPrefix}fallback:${nonce}`) {
      connected();
      return;
    }
    const socketReply = `${portPrefix}socket:${nonce}:`;
    if (
      connecting &&
      typeof event.data === "string" &&
      event.data.startsWith(socketReply)
    ) {
      if (socket) {
        closeBridge();
        return;
      }
      try {
        socket = new WebSocket(event.data.slice(socketReply.length));
        socket.onopen = () => {
          if (active) {
            connected();
          }
        };
        socket.onmessage = (message) => bunawayNative.onmessage(message);
        socket.onerror = closeBridge;
        socket.onclose = closeBridge;
      } catch {
        closeBridge();
      }
      return;
    }
    for (const listener of textListeners) {
      listener({
        data: event.data,
      });
    }
    // Older SDKs and direct structured-value users retain the original bridge contract.
    if (listeners.size > 0) {
      const payload = JSON.parse(event.data);
      for (const listener of listeners) {
        listener({
          data: payload,
        });
      }
    }
  };
  if (!globalThis.chrome) {
    globalThis.chrome = {};
  }
  const chrome = globalThis.chrome;
  Object.defineProperty(chrome, "webview", {
    value: bridge,
  });
  addEventListener("pagehide", closeBridge, {
    once: true,
  });
  bunawayNative.postMessage(portRequest);
})();
