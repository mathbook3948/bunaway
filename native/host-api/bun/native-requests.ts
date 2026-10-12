import assert from "node:assert/strict";
import { API_LIMITS, type HostContext } from "@bunaway/protocol";

/** Own active native calls. Cancellation releases capacity while callers still observe late settlement. */
export class NativeRequests {
  private readonly active = new Map<
    string,
    {
      context: HostContext;
      controller: AbortController;
    }
  >();

  /** Register before starting plugin code; the returned signal identifies this exact lifetime. */
  begin(id: string, context: HostContext): AbortSignal {
    assert(
      !this.active.has(id) && this.active.size < API_LIMITS.maxPending,
      "Invalid native request",
    );
    const controller = new AbortController();
    this.active.set(id, {
      context,
      controller,
    });
    return controller.signal;
  }

  context(id: string): HostContext | undefined {
    return this.active.get(id)?.context;
  }

  /** Release a completed call only if cancellation or a newer lifetime has not replaced it. */
  finish(id: string, signal: AbortSignal): boolean {
    if (this.active.get(id)?.controller.signal !== signal) {
      return false;
    }
    this.active.delete(id);
    return true;
  }

  cancel(id: string): void {
    const call = this.active.get(id);
    this.active.delete(id);
    call?.controller.abort();
  }

  cancelContext(context: HostContext): void {
    for (const [id, call] of this.active) {
      if (call.context === context) {
        this.cancel(id);
      }
    }
  }

  cancelAll(): void {
    for (const id of this.active.keys()) {
      this.cancel(id);
    }
  }
}
