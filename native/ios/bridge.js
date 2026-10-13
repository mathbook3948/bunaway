import { connectMobileBridge } from "../mobile/bridge.js";

// Swift supplies this identity before the packaged main document starts executing.
const nonce = "__BUNAWAY_DOCUMENT_NONCE__";
const native = {
  postMessage(data) {
    webkit.messageHandlers.bunaway.postMessage({
      nonce,
      data,
    });
  },
};
Object.defineProperty(globalThis, "__bunawayReceive", {
  value(documentNonce, data) {
    if (documentNonce === nonce) {
      native.onmessage({
        data,
      });
    }
  },
});
Object.defineProperty(globalThis, "__bunawayClose", {
  value(documentNonce) {
    if (documentNonce === nonce) {
      native.onclose();
    }
  },
});
// A cached page has a revoked capability. Load a new document instead of reusing its connection.
addEventListener("pageshow", (event) => {
  if (event.persisted) {
    location.reload();
  }
});
connectMobileBridge(native, nonce);
