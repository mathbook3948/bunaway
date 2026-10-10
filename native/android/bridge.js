// The Android origin-matched native object exists before app scripts run.
(() => {
  if (window !== window.top || !globalThis.bunawayNative) {
    return;
  }
  const listeners = new Set();
  let active = true;
  const bridge = {
    postMessage(message) {
      if (!active) {
        throw new Error("Bunaway document closed");
      }
      bunawayNative.postMessage(JSON.stringify(message));
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
  bunawayNative.onmessage = (event) => {
    if (!active) {
      return;
    }
    const payload = JSON.parse(event.data);
    for (const listener of listeners) {
      listener({
        data: payload,
      });
    }
  };
  if (!globalThis.chrome) {
    globalThis.chrome = {};
  }
  const chrome = globalThis.chrome;
  Object.defineProperty(chrome, "webview", {
    value: bridge,
  });
  addEventListener(
    "pagehide",
    () => {
      active = false;
      listeners.clear();
    },
    {
      once: true,
    },
  );
})();
