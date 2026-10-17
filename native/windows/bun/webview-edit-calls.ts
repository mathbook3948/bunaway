import type { ComHandler } from "./com.ts";

/** How long a closed view waits for WebView2 to release an in-flight completion handler. */
export const EDIT_COMPLETION_GRACE_MS = 5_000;
/**
 * Abandoned handlers above this count make new editing calls skip as busy until native releases
 * some; abandonment itself still proceeds so window cleanup always completes.
 */
export const MAX_ABANDONED_COMPLETIONS = 64;
/** Editing calls one view may have in flight; further commands are skipped as busy. */
export const MAX_IN_FLIGHT_EDIT_CALLS = 8;

/** The COM handler surface the tracker needs; real handlers come from `handler()` in com.ts. */
export type EditCompletion = Pick<ComHandler, "refs">;

/** Registry operations injected so the tracker has no native dependency of its own. */
export type EditCompletionRegistry<T extends EditCompletion> = {
  /** Release handlers whose only remaining reference is the owner's. */
  dispose(handlers: readonly T[]): void;
  /** Unregister handlers without releasing their trampolines. */
  abandon(handlers: readonly T[]): void;
  /** Release previously abandoned handlers once native has dropped its reference. */
  reclaim(handlers: readonly T[]): void;
};

type Abandoned = {
  completion: EditCompletion;
  reclaim(): void;
};

// Abandoned handlers stay alive: if WebView2 still holds one and invokes it later, the trampoline
// and its closure must stay valid. Their callbacks are inert (see `isActive`). An entry is
// reclaimed as soon as native has released it.
const abandoned: Abandoned[] = [];

/** Number of handlers currently kept alive after abandonment (diagnostics and tests). */
export function abandonedCompletionCount(): number {
  return abandoned.length;
}

/** Release abandoned handlers that native has since dropped; never call inside a COM callback. */
function reclaimAbandoned(): void {
  for (let index = abandoned.length - 1; index >= 0; index--) {
    const entry = abandoned[index];
    if (entry && entry.completion.refs === 1) {
      abandoned.splice(index, 1);
      entry.reclaim();
    }
  }
}

type Call<T> = {
  completion: T;
  command: string;
  /** Make the handler's callback inert for good. */
  silence(): void;
};

/**
 * Own the completion handlers of one view's in-flight editing commands.
 *
 * WebView2 holds a reference to a handler until it has invoked it or closed the controller, and
 * which of the two happens to a call still pending at close is not specified. The view
 * therefore waits a bounded time for the release and then abandons what is left, so cleanup
 * always completes. A handler's callback must check `isActive()` and do nothing once it is false.
 */
export class EditCommandCalls<T extends EditCompletion> {
  private readonly calls = new Set<Call<T>>();

  constructor(private readonly registry: EditCompletionRegistry<T>) {}

  /** Calls whose handler this view still owns, finished or not. */
  get size(): number {
    return this.calls.size;
  }

  /**
   * Whether a new call should be skipped: this view has MAX_IN_FLIGHT_EDIT_CALLS calls tracked, or
   * more than MAX_ABANDONED_COMPLETIONS abandoned handlers are still held process-wide. Judged on
   * the current state, so call `prune` first (outside COM callbacks) to count released handlers out.
   */
  isBusy(): boolean {
    return (
      this.calls.size >= MAX_IN_FLIGHT_EDIT_CALLS ||
      abandoned.length > MAX_ABANDONED_COMPLETIONS
    );
  }

  /**
   * Track a call. `begin` starts the native call and receives the `isActive` guard its callback
   * must consult; it returns the handler that native now references. A call started from inside
   * another call's completion passes `prune: false`.
   *
   * When `begin` fails after creating its handler, it may throw an error whose `completion`
   * property is that handler. The handler is then kept, silenced, and released by a later
   * `prune` or `release`, because disposing it here could happen inside a COM callback.
   */
  start(
    command: string,
    begin: (isActive: () => boolean) => T,
    {
      prune = true,
    }: {
      prune?: boolean;
    } = {},
  ): void {
    // Pruning disposes handlers, which must not happen inside a COM callback.
    if (prune) {
      this.prune();
    }
    let active = true;
    const silence = () => {
      active = false;
    };
    try {
      this.calls.add({
        completion: begin(() => active),
        command,
        silence,
      });
    } catch (error) {
      silence();
      const orphan = (
        error as {
          completion?: T;
        }
      ).completion;
      if (orphan) {
        this.calls.add({
          completion: orphan,
          command,
          silence,
        });
      }
      throw error;
    }
  }

  /** Dispose handlers that native has released, whether or not they ran, and reclaim abandoned ones. */
  prune(): void {
    reclaimAbandoned();
    const released = [
      ...this.calls,
    ].filter((call) => call.completion.refs === 1);
    if (!released.length) {
      return;
    }
    this.registry.dispose(released.map((call) => call.completion));
    for (const call of released) {
      call.silence();
      this.calls.delete(call);
    }
  }

  /**
   * Whether cleanup may continue. While native holds a handler this waits up to the grace period
   * measured from `closedForMs`; after that the remaining handlers are abandoned and
   * `abandonedCall` reports each one with the global count and whether it exceeds
   * MAX_ABANDONED_COMPLETIONS. Abandonment is never refused, so cleanup always completes.
   */
  settle(
    closedForMs: number,
    abandonedCall: (command: string, total: number, overLimit: boolean) => void,
  ): boolean {
    reclaimAbandoned();
    const outstanding = [
      ...this.calls,
    ].filter((call) => call.completion.refs > 1);
    if (!outstanding.length) {
      return true;
    }
    if (closedForMs <= EDIT_COMPLETION_GRACE_MS) {
      return false;
    }
    this.registry.abandon(outstanding.map((call) => call.completion));
    for (const call of outstanding) {
      call.silence();
      this.calls.delete(call);
      const { completion } = call;
      abandoned.push({
        completion,
        reclaim: () =>
          this.registry.reclaim([
            completion,
          ]),
      });
      abandonedCall(
        call.command,
        abandoned.length,
        abandoned.length > MAX_ABANDONED_COMPLETIONS,
      );
    }
    return true;
  }

  /** Handlers still owned by the view; all hold only the owner reference once `settle` is true. */
  handlers(): T[] {
    return [
      ...this.calls,
    ].map((call) => call.completion);
  }

  /** Dispose every remaining handler after `settle` allowed cleanup, and silence their callbacks. */
  release(): void {
    const remaining = this.handlers();
    for (const call of this.calls) {
      call.silence();
    }
    this.calls.clear();
    this.registry.dispose(remaining);
  }
}
