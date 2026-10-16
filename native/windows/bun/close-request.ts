/**
 * How an app-level close request ended.
 * `cancelled` means no decision was made, for example because the document that was asked went away.
 */
export type CloseDecision = "allow" | "deny" | "cancelled";

type PendingCloseRequest = {
  requestId: number;
  settle(decision: CloseDecision): void;
};

/**
 * Tracks the `windows.closeRequested` question asked of one window lifetime.
 *
 * At most one request is pending, because the owner reserves the window's close subtree while it
 * waits. Request IDs increase from 1 and are never reused within this object, which lives as long as
 * the windowId it belongs to. Settling is idempotent, so every cancellation path may call `cancel`.
 */
export class CloseRequests {
  private lastRequestId = 0;
  private pending: PendingCloseRequest | undefined;

  /** Opens a request; the decision settles through `respond` or `cancel`, never by timeout. */
  begin(): {
    requestId: number;
    decision: Promise<CloseDecision>;
  } {
    const requestId = ++this.lastRequestId;
    const decision = new Promise<CloseDecision>((resolve) => {
      this.pending = {
        requestId,
        settle: resolve,
      };
    });
    return {
      requestId,
      decision,
    };
  }

  /** Records the app's answer. Returns false when the ID is unknown, answered or cancelled. */
  respond(requestId: number, allow: boolean): boolean {
    if (this.pending?.requestId !== requestId) {
      return false;
    }
    this.settle(allow ? "allow" : "deny");
    return true;
  }

  /**
   * Abandons the pending request as not approved. With `requestId`, only that request is
   * affected, so a late failure cannot cancel a newer question.
   */
  cancel(requestId?: number): void {
    if (!this.pending) {
      return;
    }
    if (requestId === undefined || this.pending.requestId === requestId) {
      this.settle("cancelled");
    }
  }

  private settle(decision: CloseDecision): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.settle(decision);
  }
}
