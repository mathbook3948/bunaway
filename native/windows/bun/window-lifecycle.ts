import assert from "node:assert/strict";

type CloseRequest = "user" | "forced";
type WindowPhase =
  | {
      kind: "live";
      closeRequest?: CloseRequest;
    }
  | {
      kind: "closing";
    }
  | {
      kind: "detached";
    }
  | {
      kind: "finished";
    }
  | {
      kind: "released";
      profile: "pending" | "retained" | "released";
    };

/**
 * Own one native window's retirement order independently of document readiness.
 * Profile retention completes recreation preparation, but does not end profile ownership.
 * The UI owner performs native work before advancing each cleanup phase.
 */
export class WindowLifecycle {
  private state: WindowPhase = {
    kind: "live",
  };

  get phase(): WindowPhase["kind"] {
    return this.state.kind;
  }

  get closed(): boolean {
    return this.state.kind !== "live";
  }

  /** Native release and profile disposition have settled, including approved retention. */
  get cleanupComplete(): boolean {
    return this.state.kind === "released" && this.state.profile !== "pending";
  }

  requestClose(force: boolean): void {
    if (this.state.kind !== "live") {
      return;
    }
    // A later caption close cannot downgrade a renderer failure's forced retirement.
    if (force || this.state.closeRequest !== "forced") {
      this.state.closeRequest = force ? "forced" : "user";
    }
  }

  takeCloseRequest(): CloseRequest | undefined {
    if (this.state.kind !== "live") {
      return undefined;
    }
    const request = this.state.closeRequest;
    delete this.state.closeRequest;
    return request;
  }

  /** Commit once after user policy accepts closure; a declined close stays live. */
  commitClose(): boolean {
    if (this.closed) {
      return false;
    }
    this.state = {
      kind: "closing",
    };
    return true;
  }

  detached(): void {
    assert(this.state.kind === "closing");
    this.state = {
      kind: "detached",
    };
  }

  finished(): void {
    assert(this.state.kind === "detached");
    this.state = {
      kind: "finished",
    };
  }

  released(): void {
    assert(this.state.kind === "finished");
    this.state = {
      kind: "released",
      profile: "pending",
    };
  }

  settleProfile(retain: boolean, release: () => boolean): void {
    assert(this.state.kind === "released");
    if (this.state.profile !== "pending") {
      return;
    }
    if (retain) {
      this.state.profile = "retained";
    } else if (release()) {
      this.state.profile = "released";
    }
  }

  /** Abandon retained storage without repeating HWND, COM or relationship cleanup. */
  cancelReplacement(): void {
    if (this.state.kind === "released" && this.state.profile === "retained") {
      this.state.profile = "pending";
    }
  }
}
