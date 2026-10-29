import type { NativeEnvironment } from "@bunaway/plugin";
import {
  dispose,
  initialize as initializeNodeStore,
  type NodeStore,
} from "#store/platforms/node-store";

/**
 * The node:fs implementation both platforms share. This module is the platform boundary that the
 * plugin build replaces with a stub in browser bundles, which keeps node:fs out of the WebView.
 */
export { dispose };

/**
 * The macOS host does not accept I/O Worker plugin events on its main thread, so the store runs
 * without the event service there and changes go unannounced.
 */
export function initialize(environment: NativeEnvironment): NodeStore {
  const { events: _unsupported, ...withoutEvents } = environment;
  return initializeNodeStore(withoutEvents);
}
