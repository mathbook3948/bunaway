import type { ComHandler } from "./com.ts";

/** How long a closed view waits for WebView2 to release an in-flight completion handler. */
export const EDIT_COMPLETION_GRACE_MS = 5_000;
/** Bound on handlers kept alive after abandonment; reaching it is a host defect, not a state to absorb. */
export const MAX_ABANDONED_COMPLETIONS = 64;

/** The COM handler surface the tracker needs; real handlers come from `handler()` in com.ts. */
export type EditCompletion = Pick<ComHandler, "refs">;

/** Registry operations injected so the tracker has no native dependency of its own. */
export type EditCompletionRegistry<T extends EditCompletion> = {
  /** Release handlers whose only remaining reference is the owner's. */
  dispose(handlers: readonly T[]): void;
  /** Unregister handlers without releasing their trampolines. */
  abandon(handlers: readonly T[]): void;
};

// Abandoned handlers are never released: if WebView2 still holds one and invokes it later, the
// trampoline and its closure must stay valid. Their callbacks are inert (see `isActive`).
const abandoned: EditCompletion[] = [];

/** Number of handlers deliberately kept alive after abandonment (diagnostics and tests). */
export function abandonedCompletionCount(): number {
  return abandoned.length;
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
 * the documentation does not say which happens to a call still pending at close. The view
 * therefore waits a bounded time for the release and then abandons what is left, so cleanup
 * always completes. A handler's callback must check `isActive()` and do nothing once it is false.
 */
export class EditCommandCalls<T extends EditCompletion> {
  private readonly calls = new Set<Call<T>>();

  constructor(private readonly registry: EditCompletionRegistry<T>) {}

  /**
   * Track a call. `begin` starts the native call and receives the `isActive` guard its callback
   * must consult; it returns the handler that native now references.
   */
  start(command: string, begin: (isActive: () => boolean) => T): void {
    this.prune();
    let active = true;
    this.calls.add({
      completion: begin(() => active),
      command,
      silence() {
        active = false;
      },
    });
  }

  /** Dispose handlers that native has released, whether or not they ran. */
  prune(): void {
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
   * `abandonedCall` reports each one. Throws when abandonment would exceed MAX_ABANDONED_COMPLETIONS.
   */
  settle(
    closedForMs: number,
    abandonedCall: (command: string, total: number) => void,
  ): boolean {
    const outstanding = [
      ...this.calls,
    ].filter((call) => call.completion.refs > 1);
    if (!outstanding.length) {
      return true;
    }
    if (closedForMs <= EDIT_COMPLETION_GRACE_MS) {
      return false;
    }
    if (abandoned.length + outstanding.length > MAX_ABANDONED_COMPLETIONS) {
      throw new Error("Too many abandoned WebView editing completions.");
    }
    this.registry.abandon(outstanding.map((call) => call.completion));
    for (const call of outstanding) {
      call.silence();
      this.calls.delete(call);
      abandoned.push(call.completion);
      abandonedCall(call.command, abandoned.length);
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
