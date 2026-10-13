import { connectMobileBridge } from "../mobile/bridge.js";

// Android injects this object only for the configured origin. Native also checks the main frame.
if (window === window.top && globalThis.bunawayNative) {
  connectMobileBridge(bunawayNative, crypto.randomUUID());
}
