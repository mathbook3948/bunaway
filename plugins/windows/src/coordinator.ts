import type { WindowSpec } from "@bunaway/plugin-api/native";
import { BunawayError, type JsonValue } from "@bunaway/protocol";
import type { WindowCall } from "./contract.ts";

const WINDOW_CLEANUP_TIMEOUT_MS = 35_000;

export type WindowState = {
  closed: boolean;
  cleaned: boolean;
  ready: boolean;
  failure: unknown;
  deadline: number;
};

/** Coordinates requests without owning HWNDs or COM objects; the UI pump owns cleanup and readiness. */
export class WindowOperations {
  readonly replacing = new Set<string>();
  constructor(
    private readonly specs: readonly WindowSpec[],
    private readonly hooks: {
      read(view: string): WindowState | undefined;
      create(spec: WindowSpec): void;
      close(view: string): boolean | Promise<boolean>;
      apply(
        call: WindowCall,
        view: string,
        grants: readonly string[],
      ): JsonValue | Promise<JsonValue>;
      stopping(): boolean;
      cancelled(requestId: string): boolean;
      now(): number;
      tick(): Promise<void>;
    },
  ) {}

  /** Apply a permitted request, waiting for old cleanup and new readiness when replacing a view. */
  async execute(
    call: WindowCall,
    grants: readonly string[],
    requestId: string,
  ): Promise<JsonValue> {
    if (call.operation === "windows.list") {
      // A list only reveals views included in the caller's already-computed grants.
      return this.specs
        .filter((spec) => grants.includes(spec.view))
        .map((spec) => ({
          view: spec.view,
          open: this.hooks.read(spec.view)?.closed === false,
        }));
    }
    if (!call.payload || !("view" in call.payload)) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Expected a window operation.",
      });
    }
    const viewId = call.payload.view;
    if (!grants.includes(viewId)) {
      throw new BunawayError({
        code: "PERMISSION_DENIED",
        message: "Window policy denied.",
      });
    }
    const spec = this.specs.find((spec) => spec.view === viewId);
    if (!spec) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Window is not configured.",
      });
    }
    if (
      (this.replacing.has(viewId) &&
        call.operation !== "windows.getReadiness") ||
      (call.operation === "windows.completeSplashscreen" &&
        this.replacing.has(call.payload.splash))
    ) {
      throw new BunawayError({
        code: "BUSY",
        message: "Window is being recreated.",
      });
    }
    let view = this.hooks.read(viewId);
    if (call.operation === "windows.isDestroyed") {
      if (this.hooks.stopping() || this.hooks.cancelled(requestId)) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Window request cancelled.",
        });
      }
      return !view || view.closed;
    }
    if (
      call.operation !== "windows.create" &&
      call.operation !== "windows.recreate"
    ) {
      if (!view || (view.closed && call.operation !== "windows.getReadiness")) {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Window is not open.",
        });
      }
      if (this.hooks.stopping() || this.hooks.cancelled(requestId)) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Window request cancelled.",
        });
      }
      return this.hooks.apply(call, viewId, grants);
    }
    if (call.operation === "windows.create" && view && !view.closed) {
      throw new BunawayError({
        code: "BUSY",
        message: "Window is already open.",
      });
    }
    // Serialize create/recreate for this view until readiness or failure.
    this.replacing.add(viewId);
    try {
      if (this.hooks.stopping() || this.hooks.cancelled(requestId)) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Window request cancelled.",
        });
      }
      const closesLiveWindow = !!view && !view.closed;
      if (closesLiveWindow && !(await this.hooks.close(viewId))) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Window close was declined.",
        });
      }
      const deadline = this.hooks.now() + WINDOW_CLEANUP_TIMEOUT_MS;
      // Do not create a replacement until the UI pump confirms native cleanup of the old view.
      while (view && !view.cleaned) {
        if (
          this.hooks.stopping() ||
          (!closesLiveWindow && this.hooks.cancelled(requestId)) ||
          this.hooks.now() > deadline
        ) {
          throw new BunawayError({
            code: "CANCELLED",
            message: "Window cleanup did not complete.",
          });
        }
        await this.hooks.tick();
        view = this.hooks.read(viewId);
      }
      if (
        this.hooks.stopping() ||
        (!closesLiveWindow && this.hooks.cancelled(requestId))
      ) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Window request cancelled.",
        });
      }
      // Once close commits, finish replacement even if the old document's context is revoked.
      this.hooks.create(spec);
      view = this.hooks.read(viewId);
      // Preserve create's existing completion at controller setup; document and SDK readiness are separate.
      while (!view?.ready) {
        if (this.hooks.stopping()) {
          throw new BunawayError({
            code: "CANCELLED",
            message: "App shutdown interrupted window creation.",
          });
        }
        if (!closesLiveWindow && this.hooks.cancelled(requestId)) {
          if (view && !view.closed) {
            await this.hooks.close(viewId);
          }
          throw new BunawayError({
            code: "CANCELLED",
            message: "Window request cancelled.",
          });
        }
        if (
          !view ||
          view.closed ||
          view.failure ||
          this.hooks.now() > view.deadline
        ) {
          throw new BunawayError({
            code: "INTERNAL",
            message: "Window creation failed.",
          });
        }
        await this.hooks.tick();
        view = this.hooks.read(viewId);
      }
      return null;
    } finally {
      this.replacing.delete(viewId);
    }
  }
}
