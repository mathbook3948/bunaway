import { createAppearance } from "../win32.ts";

/** Bind appearance reads when the owning host worker activates this platform. */
export function initialize() {
  return createAppearance();
}

export function dispose(instance: ReturnType<typeof initialize>) {
  instance.dispose();
}
