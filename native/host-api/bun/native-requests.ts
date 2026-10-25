import assert from "node:assert/strict";
import { DEFAULT_MAX_PENDING, type HostContext } from "@bunaway/protocol";
import type { Packet } from "@bunaway/runtime-bun/worker-channel";

/** Own active native calls. Cancellation releases capacity while callers still observe late settlement. */
export class NativeRequests {
  private readonly active = new Map<
    string,
    {
      context: HostContext;
      controller: AbortController;
    }
  >();

  /** @param maxActive Most native calls that may run at once; the app-configured pending limit. */
  constructor(private readonly maxActive: number = DEFAULT_MAX_PENDING) {}

  private modalShutdownObserved = false;
  private readonly modalInterrupts = new Set<{
    requestId?: string;
    context?: HostContext;
    cancel(): void;
  }>();

  /** Register native-loop termination only; normal request cancellation owns final settlement. */
  onModalInterrupt(
    signal: AbortSignal | undefined,
    cancel: () => void,
  ): () => void {
    const identity = signal ? this.identity(signal) : undefined;
    const entry = {
      ...identity,
      cancel,
    };
    this.modalInterrupts.add(entry);
    // WndProc polls before delivering WM_ENTERMENULOOP. A terminal shutdown
    // observed in that gap must also terminate the newly registered native loop.
    if (this.modalShutdownObserved) {
      cancel();
    }
    return () => {
      this.modalInterrupts.delete(entry);
    };
  }

  /** Called only with validated channel packets while polling a native callback. Never releases resources. */
  interruptModal(packet: Packet): void {
    if (packet.kind === "shutdown") {
      this.modalShutdownObserved = true;
    }
    for (const entry of this.modalInterrupts) {
      if (
        packet.kind === "shutdown" ||
        (packet.kind === "cancel" &&
          packet.requestId === entry.requestId &&
          packet.context === entry.context) ||
        (packet.kind === "cancel-context" &&
          packet.context === entry.context) ||
        (packet.kind === "session-failure" &&
          packet.route.context === entry.context)
      ) {
        entry.cancel();
      }
    }
  }

  /** Register before starting plugin code; the returned signal identifies this exact lifetime. */
  begin(id: string, context: HostContext): AbortSignal {
    assert(
      !this.active.has(id) && this.active.size < this.maxActive,
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

  /** Resolve a borrowed signal to its active request identity without cancelling or releasing it. */
  private identity(signal: AbortSignal):
    | {
        requestId: string;
        context: HostContext;
      }
    | undefined {
    for (const [requestId, call] of this.active) {
      if (call.controller.signal === signal) {
        return {
          requestId,
          context: call.context,
        };
      }
    }
    return undefined;
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
