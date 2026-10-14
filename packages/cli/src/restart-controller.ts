/** Schedules a debounce deadline and returns its cancellation function. */
export type RestartTimer = (delayMs: number, ready: () => void) => () => void;

function scheduleRestart(delayMs: number, ready: () => void): () => void {
  const timer = setTimeout(ready, delayMs);
  return () => clearTimeout(timer);
}

/** Serializes app reloads and host rebuilds triggered by project changes.
 * Tries compatible reloads first and ignores work made stale by a newer edit.
 */
export class RestartController<T> {
  private revision = 0;
  private stopped = false;
  private running: Promise<void> | undefined;
  private debounce:
    | {
        ready: Promise<void>;
        cancel(): void;
      }
    | undefined;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly hooks: {
      stop(): Promise<void>;
      build(): Promise<T>;
      start(value: T, isCurrent: () => boolean): Promise<void>;
      error(error: unknown): void;
      reload?(isCurrent: () => boolean): Promise<boolean>;
    },
    private readonly schedule: RestartTimer = scheduleRestart,
  ) {}

  /** Queues a change; a positive delay coalesces saves while callers share the active pass. */
  change(delayMs = 0): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    this.revision += 1;
    this.debounce?.cancel();
    this.debounce = undefined;
    if (delayMs > 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      const cancel = this.schedule(delayMs, () => {
        this.debounce = undefined;
        resolve();
      });
      this.debounce = {
        ready: promise,
        cancel() {
          cancel();
          resolve();
        },
      };
    }
    if (!this.running) {
      this.running = this.restart();
    }
    return this.running;
  }

  private async restart(): Promise<void> {
    try {
      let applied = 0;
      while (!this.stopped && applied !== this.revision) {
        while (!this.stopped && this.debounce) {
          await this.debounce.ready;
        }
        if (this.stopped) {
          break;
        }
        applied = this.revision;
        try {
          if (
            await this.hooks.reload?.(
              () => !this.stopped && applied === this.revision,
            )
          ) {
            continue;
          }
          if (this.stopped || applied !== this.revision) {
            continue;
          }
          await this.hooks.stop();
          if (this.stopped || applied !== this.revision) {
            continue;
          }
          const result = await this.hooks.build();
          if (!this.stopped && applied === this.revision) {
            await this.hooks.start(
              result,
              () => !this.stopped && applied === this.revision,
            );
          }
        } catch (error) {
          this.hooks.error(error);
        }
      }
    } finally {
      // Release ownership in the same continuation as the last revision check. A separate
      // promise finalizer leaves a gap where change() can join a pass that already finished.
      this.running = undefined;
    }
  }

  /** Cancels pending work, waits for the active pass, and stops the current host. */
  close(): Promise<void> {
    if (this.closing) {
      return this.closing;
    }
    this.stopped = true;
    this.debounce?.cancel();
    this.debounce = undefined;
    this.closing = this.finishClose();
    return this.closing;
  }

  private async finishClose(): Promise<void> {
    await this.running;
    await this.hooks.stop();
  }
}
