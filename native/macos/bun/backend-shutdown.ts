import type { DesktopLifecycle } from "../../windows/bun/desktop.ts";

/** What the backend Worker's shutdown order needs; injected so the order is testable without a Worker. */
export type BackendShutdown = {
  /** Undefined when the app definition never loaded, so there are no app hooks to run. */
  desktop:
    | Pick<DesktopLifecycle, "dispose" | "willQuit" | "quitCompleted">
    | undefined;
  /**
   * True when the app committed an orderly shutdown cause (an approved quit, or `closing` from the
   * main thread). False means the host is failing, so the app's shutdown hooks are skipped.
   */
  orderly: boolean;
  /** Runs the app's backend and the plugin stop hooks. */
  stopCore(): Promise<void>;
  /** Tells the main thread that app-level cleanup finished. */
  reportCleaned(): Promise<void>;
  /** Settles once the main thread has torn down windows, adapters and the I/O Worker. */
  nativeStopped: Promise<void>;
};

/**
 * Runs the backend side of shutdown in the order the lifecycle contract promises:
 *
 * 1. `onWillQuit`, while the host still holds every native resource. Only for an orderly shutdown.
 * 2. Core stop and plugin stop hooks, then `cleaned` so the main thread begins native teardown.
 * 3. `onQuit`, only after the main thread reports `native-stopped`, so it runs after the windows
 *    and native adapters are gone. Only for an orderly shutdown.
 *
 * App hooks have their own deadlines inside `DesktopLifecycle` and never throw, so a failing hook
 * cannot turn an orderly shutdown into a host failure. A failing Core stop propagates.
 */
export async function runBackendShutdown(
  shutdown: BackendShutdown,
): Promise<void> {
  if (shutdown.orderly) {
    await shutdown.desktop?.willQuit();
  }
  // No queued callback or pending quit check may start once teardown has begun.
  shutdown.desktop?.dispose();
  await shutdown.stopCore();
  await shutdown.reportCleaned();
  if (shutdown.orderly) {
    await shutdown.nativeStopped;
    await shutdown.desktop?.quitCompleted();
  }
}
