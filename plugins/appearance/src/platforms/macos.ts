import { createAppearance } from "../macos.ts";

/** Bind appearance reads when the owning UI thread activates this platform. */
export function initialize() {
  return createAppearance();
}

export function dispose(instance: ReturnType<typeof initialize>) {
  instance.dispose();
}

/** Own the read-only AppKit bindings on the host's main UI thread. */
