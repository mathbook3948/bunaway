const MAX_REMOVAL_ATTEMPTS = 10;
const REMOVAL_RETRY_DELAY_MS = 100;

/** Retain the fixture's shortcut and shell ownership after failed cleanup. */
export function createNotificationShortcutCleanup({
  removeShortcut,
  notifyRemoval,
  closeShell,
  wait = (milliseconds) => Bun.sleep(milliseconds),
}: {
  removeShortcut(): Promise<void>;
  notifyRemoval(): void;
  closeShell(): void;
  wait?(milliseconds: number): Promise<void>;
}): () => Promise<void> {
  let closed = false;
  let pending: Promise<void> | undefined;
  return () => {
    if (closed) {
      return Promise.resolve();
    }
    if (pending) {
      return pending;
    }
    const cleanup = async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          await removeShortcut();
          break;
        } catch (error) {
          // CI observed a sharing lock on our UUID shortcut after native disposal.
          // Other failures remain errors; this never recursively removes a directory.
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "EBUSY" ||
            attempt === MAX_REMOVAL_ATTEMPTS
          ) {
            throw error;
          }
          await wait(REMOVAL_RETRY_DELAY_MS);
        }
      }
      notifyRemoval();
      closeShell();
      closed = true;
    };
    // One cleanup owns deletion and DLL release even when multiple callers await it.
    pending = cleanup().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
