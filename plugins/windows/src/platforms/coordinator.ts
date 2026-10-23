import type {
  NativeWindowServices,
  WindowSpec,
  WindowState,
} from "@bunaway/plugin-api/native";
import { BunawayError, type JsonValue } from "@bunaway/protocol";
import type { WindowCall } from "#windows/contract";
import { mergeCreationOptions } from "#windows/platforms/creation-options";

const WINDOW_CLEANUP_TIMEOUT_MS = 35_000;

export type { WindowState } from "@bunaway/plugin-api/native";

type CreationCall = Extract<
  WindowCall,
  {
    operation: "windows.create" | "windows.recreate";
  }
>;

/** Why a pending creation stops, and whether its half-created window must be retired first. */
type CreationInterruption = {
  error: BunawayError;
  destroyOpenWindow: boolean;
};

function isCreationCall(call: WindowCall): call is CreationCall {
  return (
    call.operation === "windows.create" || call.operation === "windows.recreate"
  );
}

/** Coordinates requests without owning HWNDs or COM objects; the UI pump owns cleanup and readiness. */
export class WindowOperations {
  readonly replacing = new Set<string>();
  private readonly destroyedReplacements = new Set<string>();
  constructor(
    private readonly specs: readonly WindowSpec[],
    private readonly hooks: Omit<NativeWindowServices, "specs" | "window"> & {
      apply(call: WindowCall, key: string): JsonValue | Promise<JsonValue>;
    },
  ) {}

  /** The app's one window declaration; the host configuration always carries exactly one. */
  private get spec(): WindowSpec {
    const [spec] = this.specs;
    if (!spec) {
      throw new Error("Missing window configuration.");
    }
    return spec;
  }

  /** Apply a permitted request, waiting for old cleanup and new readiness when replacing the window. */
  async execute(call: WindowCall, requestId: string): Promise<JsonValue> {
    const spec = this.spec;
    const viewId = spec.view;
    this.rejectWhileReplacing(call, viewId);
    const view = this.hooks.read(viewId);
    if (call.operation === "windows.isOpen") {
      this.throwIfCancelled(requestId);
      return view?.closed === false;
    }
    if (call.operation === "windows.isFocused" && (!view || view.closed)) {
      this.throwIfCancelled(requestId);
      return false;
    }
    if (call.operation === "windows.destroy") {
      return this.destroy(call, requestId, viewId, view);
    }
    if (!isCreationCall(call)) {
      return this.applyToOpenWindow(call, requestId, viewId, view);
    }
    this.validateCreationRequest(call);
    return this.createWindow(
      call,
      requestId,
      spec,
      mergeCreationOptions(spec, call.payload.options),
      view,
    );
  }

  /** Reject a request that the app is stopping or the caller cancelled. */
  private throwIfCancelled(requestId: string): void {
    if (this.hooks.stopping() || this.hooks.cancelled(requestId)) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Window request cancelled.",
      });
    }
  }

  /** Check that the platform supports the requested creation options. */
  private validateCreationRequest(call: CreationCall): void {
    if (
      call.payload.options &&
      Object.keys(call.payload.options).length !== 0 &&
      !this.hooks.supportsCreationOptions
    ) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message:
          "Window creation options are not implemented on this platform.",
      });
    }
  }

  /** A window being recreated accepts only readiness reads and trusted destruction. */
  private rejectWhileReplacing(call: WindowCall, viewId: string): void {
    if (
      this.replacing.has(viewId) &&
      call.operation !== "windows.getReadiness" &&
      call.operation !== "windows.destroy"
    ) {
      throw new BunawayError({
        code: "BUSY",
        message: "Window is being recreated.",
      });
    }
  }

  /** Trusted destruction also ends an in-flight recreation so it cannot reopen the window. */
  private destroy(
    call: WindowCall,
    requestId: string,
    viewId: string,
    view: WindowState | undefined,
  ): JsonValue | Promise<JsonValue> {
    this.throwIfCancelled(requestId);
    // A closed view the host still remembers is no window either: destroying it must not end the app.
    if (!view || (view.closed && !this.replacing.has(viewId))) {
      if (!this.hooks.destroy) {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message:
            "Trusted window destruction is not implemented on this platform.",
        });
      }
      return true;
    }
    // Native support is checked synchronously by the adapter before destruction starts.
    // A rejected unsupported call must leave an existing recreation running.
    const result = this.hooks.apply(call, viewId);
    if (this.replacing.has(viewId)) {
      this.destroyedReplacements.add(viewId);
    }
    return result;
  }

  /** Forward an operation on an existing window; readiness may be read after the window closed. */
  private applyToOpenWindow(
    call: WindowCall,
    requestId: string,
    viewId: string,
    view: WindowState | undefined,
  ): JsonValue | Promise<JsonValue> {
    if (!view || (view.closed && call.operation !== "windows.getReadiness")) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Window is not open.",
      });
    }
    this.throwIfCancelled(requestId);
    return this.hooks.apply(call, viewId);
  }

  /** Create or recreate the window, holding the request until it is ready or the attempt fails. */
  private async createWindow(
    call: CreationCall,
    requestId: string,
    spec: WindowSpec,
    creationSpec: WindowSpec,
    view: WindowState | undefined,
  ): Promise<JsonValue> {
    const viewId = spec.view;
    if (call.operation === "windows.create" && view && !view.closed) {
      throw new BunawayError({
        code: "BUSY",
        message: "Window is already open; use show or recreate.",
      });
    }
    this.hooks.validateCreation?.(creationSpec);
    // Serialize create/recreate until readiness or failure.
    this.replacing.add(viewId);
    let creationStarted = false;
    try {
      this.throwIfCancelled(requestId);
      const closesLiveWindow = !!view && !view.closed;
      if (closesLiveWindow && !(await this.hooks.close(viewId))) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Window close was declined.",
        });
      }
      // Do not create a replacement until the UI pump confirms native cleanup of the old window.
      // Suspend only when there is something to wait for, so a first creation starts synchronously.
      if (view && !view.cleaned) {
        view = await this.awaitCleanup(
          requestId,
          viewId,
          closesLiveWindow,
          view,
        );
      }
      if (this.replacementStopped(requestId, viewId, closesLiveWindow, view)) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Window request cancelled.",
        });
      }
      // Once close commits, finish replacement even if the old document's context is revoked.
      creationStarted = true;
      this.hooks.create(creationSpec, closesLiveWindow, viewId);
      return await this.awaitReadiness(requestId, viewId, closesLiveWindow);
    } catch (error) {
      if (this.unreadyWindowNeedsDestroy(viewId, creationStarted)) {
        await this.hooks.destroy?.(viewId);
      }
      throw error;
    } finally {
      this.replacing.delete(viewId);
      this.destroyedReplacements.delete(viewId);
      this.hooks.creationSettled?.(viewId);
    }
  }

  /** Whether a replacement should stop: shutdown, trusted destruction, a parent's end or a cancelled request. */
  private replacementStopped(
    requestId: string,
    viewId: string,
    closesLiveWindow: boolean,
    view: WindowState | undefined,
  ): boolean {
    return (
      this.hooks.stopping() ||
      this.destroyedReplacements.has(viewId) ||
      (closesLiveWindow && view?.replacementCancelled === true) ||
      (!closesLiveWindow && this.hooks.cancelled(requestId))
    );
  }

  /** Poll until the UI pump confirms native cleanup of the old view, returning its final state. */
  private async awaitCleanup(
    requestId: string,
    viewId: string,
    closesLiveWindow: boolean,
    initialView: WindowState,
  ): Promise<WindowState | undefined> {
    let view: WindowState | undefined = initialView;
    const deadline = this.hooks.now() + WINDOW_CLEANUP_TIMEOUT_MS;
    while (view && !view.cleaned) {
      if (
        this.replacementStopped(requestId, viewId, closesLiveWindow, view) ||
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
    return view;
  }

  /**
   * Wait for controller setup.
   * Preserves create's existing completion at controller setup; document and SDK readiness are separate.
   */
  private async awaitReadiness(
    requestId: string,
    viewId: string,
    closesLiveWindow: boolean,
  ): Promise<JsonValue> {
    let view = this.hooks.read(viewId);
    while (true) {
      const interruption = this.creationInterruption(
        requestId,
        viewId,
        closesLiveWindow,
        view,
      );
      if (interruption) {
        if (interruption.destroyOpenWindow && view && !view.closed) {
          await (this.hooks.destroy ?? this.hooks.close)(viewId);
        }
        throw interruption.error;
      }
      this.assertCreationProgress(view);
      // Readiness and termination can both arrive before this request resumes.
      if (view.ready) {
        return null;
      }
      await this.hooks.tick();
      view = this.hooks.read(viewId);
    }
  }

  /** Describe why this creation must stop (shutdown, destruction, a parent's end or the caller), if it must. */
  private creationInterruption(
    requestId: string,
    viewId: string,
    closesLiveWindow: boolean,
    view: WindowState | undefined,
  ): CreationInterruption | undefined {
    if (
      this.hooks.stopping() ||
      this.destroyedReplacements.has(viewId) ||
      view?.replacementCancelled
    ) {
      return {
        error: new BunawayError({
          code: "CANCELLED",
          message: "Window creation was cancelled.",
        }),
        destroyOpenWindow: false,
      };
    }
    if (!closesLiveWindow && this.hooks.cancelled(requestId)) {
      return {
        error: new BunawayError({
          code: "CANCELLED",
          message: "Window request cancelled.",
        }),
        destroyOpenWindow: true,
      };
    }
    return undefined;
  }

  /** Surface a capability failure as is; any other setup failure or timeout is an internal error. */
  private assertCreationProgress(
    view: WindowState | undefined,
  ): asserts view is WindowState {
    // Capability failures are intentional public errors, not internal controller diagnostics.
    if (
      view?.failure instanceof BunawayError &&
      view.failure.code === "UNSUPPORTED"
    ) {
      throw view.failure;
    }
    if (
      !view ||
      view.closed ||
      view.failure ||
      (!view.ready && this.hooks.now() > view.deadline)
    ) {
      throw new BunawayError({
        code: "INTERNAL",
        message: "Window creation failed.",
      });
    }
  }

  /** Whether a window whose creation started but never became ready must be retired so it cannot linger. */
  private unreadyWindowNeedsDestroy(
    viewId: string,
    creationStarted: boolean,
  ): boolean {
    const current = this.hooks.read(viewId);
    return (
      creationStarted &&
      !!current &&
      !current.closed &&
      !current.ready &&
      !!this.hooks.destroy
    );
  }
}
