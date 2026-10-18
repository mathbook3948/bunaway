const MAX_REMOVAL_ATTEMPTS = 10;
const REMOVAL_RETRY_DELAY_MS = 100;

/** A failed creation still owns cleanup when its first deletion attempt fails. */
export class NotificationShortcutCreationError extends AggregateError {
  constructor(
    creationError: unknown,
    cleanupError: unknown,
    readonly cleanup: () => Promise<void>,
  ) {
    super(
      [
        creationError,
        cleanupError,
      ],
      "Notification shortcut creation and cleanup failed.",
    );
    this.name = "NotificationShortcutCreationError";
  }
}

/** Clean up a failed creation, preserving both errors and retry ownership if deletion fails. */
export async function cleanupFailedNotificationShortcutCreation(
  creationError: unknown,
  cleanup: () => Promise<void>,
): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    throw new NotificationShortcutCreationError(
      creationError,
      cleanupError,
      cleanup,
    );
  }
  throw creationError;
}

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
    if (pending !== undefined) {
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
