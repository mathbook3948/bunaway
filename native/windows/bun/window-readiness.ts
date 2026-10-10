import type { WindowReadiness } from "@bunaway/plugin-api/native";
import type { WireError } from "@bunaway/protocol";

/** Owns preparation facts for one HWND. Native callbacks supply document and session identity. */
export class WindowReadinessTracker {
  private state: WindowReadiness;
  private autoShow: "document" | "sdk" | undefined;
  private terminated = false;
  constructor(
    windowId: string,
    viewId: string,
    showWhenReady: "document" | "sdk" | undefined,
    private readonly hooks: {
      publish(state: WindowReadiness): void;
      show(): void;
    },
  ) {
    this.autoShow = showWhenReady;
    this.state = {
      windowId,
      viewId,
      documentGeneration: 0,
      revision: 0,
      nativeCreated: true,
      document: "pending",
      sdk: "pending",
      error: null,
    };
  }

  /** Return an isolated snapshot, also available after failure or close until replacement. */
  snapshot(): WindowReadiness {
    return structuredClone(this.state);
  }

  /** A new top-level document invalidates both preparation stages before any new session is opened. */
  reset(documentGeneration: number): void {
    if (this.terminated) {
      return;
    }
    this.commit({
      documentGeneration,
      document: "pending",
      sdk: "pending",
      error: null,
    });
  }

  /** WebView2 NavigationCompleted for the active navigation, after origin validation. */
  documentComplete(error: WireError | null): void {
    if (this.state.document !== "pending") {
      return;
    }
    if (error) {
      this.commit({
        document: error.code === "CANCELLED" ? "cancelled" : "failed",
        sdk: this.state.sdk === "pending" ? "cancelled" : this.state.sdk,
        error,
      });
      return;
    }
    this.commit({
      document: "ready",
    });
  }

  /** Only an acknowledgement from the current negotiated route can complete SDK preparation. */
  sdkComplete(documentGeneration: number): void {
    if (
      documentGeneration !== this.state.documentGeneration ||
      this.state.sdk !== "pending"
    ) {
      return;
    }
    this.commit({
      sdk: "ready",
    });
  }

  /** Reconnecting an SDK on the same loaded document starts a new acknowledged session. */
  sessionOpened(documentGeneration: number): void {
    if (this.terminated) {
      return;
    }
    this.commit({
      documentGeneration,
      sdk: "pending",
      error:
        this.state.document === "ready" || this.state.document === "pending"
          ? null
          : this.state.error,
    });
  }

  /** Session termination preserves a loaded document but invalidates SDK readiness. */
  sessionEnded(documentGeneration: number, error: WireError): void {
    if (this.terminated) {
      return;
    }
    this.commit({
      documentGeneration,
      sdk: error.code === "CANCELLED" ? "cancelled" : "failed",
      error,
    });
  }

  /** Close, shutdown and native failures are terminal for both stages and prevent delayed auto-show. */
  terminate(error: WireError): void {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    this.autoShow = undefined;
    const phase = error.code === "CANCELLED" ? "cancelled" : "failed";
    this.commit({
      document: phase,
      sdk: phase,
      error,
    });
  }

  /** Bound document/SDK preparation; a document-only app need not create an SDK session. */
  expireDocument(): void {
    if (this.state.document === "pending") {
      this.documentComplete({
        code: "TIMEOUT",
        message: "Document preparation timed out.",
      });
    }
  }

  /** SDK setup has its own deadline, independent of the document's outstanding resources. */
  expireSdk(): void {
    if (this.state.sdk === "pending") {
      this.commit({
        sdk: "failed",
        error: {
          code: "TIMEOUT",
          message: "SDK preparation timed out.",
        },
      });
    }
  }

  private commit(update: Partial<WindowReadiness>): void {
    this.state = {
      ...this.state,
      ...update,
      revision: this.state.revision + 1,
    };
    this.hooks.publish(this.snapshot());
    if (
      this.autoShow &&
      this.state.document === "ready" &&
      (this.autoShow === "document" || this.state.sdk === "ready")
    ) {
      this.autoShow = undefined;
      this.hooks.show();
    }
  }
}
