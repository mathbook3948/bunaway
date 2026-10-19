import {
  MAX_WINDOW_INSTANCES,
  type NativeWindowServices,
  type WindowSpec,
  type WindowState,
} from "@bunaway/plugin-api/native";
import { BunawayError, type JsonValue } from "@bunaway/protocol";
import type { WindowCall } from "#windows/contract";
import { mergeCreationOptions } from "#windows/platforms/creation-options";

const WINDOW_CLEANUP_TIMEOUT_MS = 35_000;

export type { WindowState } from "@bunaway/plugin-api/native";

type ListCall = Extract<
  WindowCall,
  {
    operation: "windows.list" | "windows.listInstances";
  }
>;
type CreationCall = Extract<
  WindowCall,
  {
    operation:
      | "windows.create"
      | "windows.recreate"
      | "windows.createInstance"
      | "windows.recreateInstance";
  }
>;
/** A request addressed to a configured view; every operation except listing is one. */
type TargetedCall = Extract<
  WindowCall,
  {
    payload: {
      view: string;
    };
  }
>;

/** The view, spec and native instance key that a request addresses. */
type ResolvedTarget = {
  spec: WindowSpec;
  policyView: string;
  viewId: string;
  suppliedId: string | undefined;
  creationSpec: WindowSpec | undefined;
};

/** Why a pending creation stops, and whether its half-created window must be retired first. */
type CreationInterruption = {
  error: BunawayError;
  destroyOpenWindow: boolean;
};

function isListCall(call: WindowCall): call is ListCall {
  return (
    call.operation === "windows.list" ||
    call.operation === "windows.listInstances"
  );
}

function isCreationCall(call: WindowCall): call is CreationCall {
  return (
    call.operation === "windows.create" ||
    call.operation === "windows.recreate" ||
    call.operation === "windows.createInstance" ||
    call.operation === "windows.recreateInstance"
  );
}

function isTargetedCall(call: WindowCall): call is TargetedCall {
  return !!call.payload && "view" in call.payload;
}

/** Coordinates requests without owning HWNDs or COM objects; the UI pump owns cleanup and readiness. */
export class WindowOperations {
  readonly replacing = new Set<string>();
  private readonly reservedViews = new Map<string, string>();
  private readonly destroyedReplacements = new Set<string>();
  constructor(
    private readonly specs: readonly WindowSpec[],
    private readonly hooks: Omit<NativeWindowServices, "specs" | "window"> & {
      apply(call: WindowCall, key: string): JsonValue | Promise<JsonValue>;
    },
  ) {}

  /** Apply a permitted request, waiting for old cleanup and new readiness when replacing a view. */
  async execute(call: WindowCall, requestId: string): Promise<JsonValue> {
    if (isListCall(call)) {
      return this.list(call, requestId);
    }
    if (!isTargetedCall(call)) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Expected a window operation.",
      });
    }
    const target = this.resolveTarget(call);
    if (target === undefined) {
      return true;
    }
    const { viewId } = target;
    this.rejectWhileReplacing(call, viewId);
    const view = this.hooks.read(viewId);
    if (call.operation === "windows.destroy") {
      return this.destroy(call, requestId, viewId, view);
    }
    if (call.operation === "windows.isDestroyed") {
      this.throwIfCancelled(requestId);
      return !view || view.closed;
    }
    if (!isCreationCall(call)) {
      return this.applyToOpenWindow(call, requestId, target, view);
    }
    return this.createWindow(call, requestId, target, view);
  }

  /** List configured views or native lifetimes; instance listing needs a platform catalog. */
  private list(call: ListCall, requestId: string): JsonValue {
    this.throwIfCancelled(requestId);
    const entries = this.hooks.instances?.();
    if (call.operation === "windows.listInstances" && !entries) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Window instances are not implemented on this platform.",
      });
    }
    if (call.operation === "windows.listInstances") {
      return this.specs.flatMap((spec) =>
        (entries ?? [])
          .filter(
            (entry) =>
              entry.identity.viewId === spec.view &&
              this.hooks.read(entry.key)?.closed === false,
          )
          .map((entry) => ({
            ...entry.identity,
          })),
      );
    }
    return this.specs.map((spec) => ({
      view: spec.view,
      open: entries
        ? entries.some(
            (entry) =>
              entry.identity.viewId === spec.view &&
              this.hooks.read(entry.key)?.closed === false,
          )
        : this.hooks.read(spec.view)?.closed === false,
    }));
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

  /**
   * Validate the request against the configured views and resolve its native key.
   * Returns undefined when `windows.isDestroyed` names a lifetime that no longer exists.
   */
  private resolveTarget(call: TargetedCall): ResolvedTarget | undefined {
    const policyView = call.payload.view;
    const spec = this.specs.find((spec) => spec.view === policyView);
    if (!spec) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Window is not configured.",
      });
    }
    let creationSpec: WindowSpec | undefined;
    if (isCreationCall(call)) {
      creationSpec = mergeCreationOptions(spec, call.payload.options);
      this.validateCreationRequest(call, spec);
    }
    if (call.operation === "windows.completeSplashscreen") {
      this.validateSplashscreen(spec, call.payload.splash);
    }
    const suppliedId =
      "windowId" in call.payload ? call.payload.windowId : undefined;
    let viewId: string | undefined;
    if (
      call.operation === "windows.createInstance" &&
      spec.instances === "multiple"
    ) {
      viewId = `instance-${crypto.randomUUID()}`;
    } else {
      viewId = this.resolveKey(
        policyView,
        suppliedId,
        call.operation === "windows.isDestroyed",
      );
    }
    if (viewId === undefined) {
      return undefined;
    }
    return {
      spec,
      policyView,
      viewId,
      suppliedId,
      creationSpec,
    };
  }

  /** Check that the platform and the view's instance policy permit this creation request. */
  private validateCreationRequest(call: CreationCall, spec: WindowSpec): void {
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
    const returnsIdentity =
      call.operation === "windows.createInstance" ||
      call.operation === "windows.recreateInstance";
    if (returnsIdentity && !this.hooks.instances) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Window instances are not implemented on this platform.",
      });
    }
    if (
      spec.instances === "multiple" &&
      (call.operation === "windows.create" ||
        call.operation === "windows.recreate")
    ) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message:
          "Multiple-window views require createInstance or recreateInstance.",
      });
    }
  }

  /** A splashscreen handoff moves between two single-window views. */
  private validateSplashscreen(spec: WindowSpec, splash: string): void {
    if (
      spec.instances === "multiple" ||
      this.specs.find((candidate) => candidate.view === splash)?.instances ===
        "multiple"
    ) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Splashscreen handoff requires single-window views.",
      });
    }
  }

  /** A view being recreated accepts only readiness reads and trusted destruction. */
  private rejectWhileReplacing(call: TargetedCall, viewId: string): void {
    if (
      (this.replacing.has(viewId) &&
        call.operation !== "windows.getReadiness" &&
        call.operation !== "windows.destroy") ||
      (call.operation === "windows.completeSplashscreen" &&
        this.replacing.has(call.payload.splash))
    ) {
      throw new BunawayError({
        code: "BUSY",
        message: "Window is being recreated.",
      });
    }
  }

  /** Trusted destruction also ends an in-flight recreation so it cannot reopen the view. */
  private destroy(
    call: TargetedCall,
    requestId: string,
    viewId: string,
    view: WindowState | undefined,
  ): JsonValue | Promise<JsonValue> {
    this.throwIfCancelled(requestId);
    if (!view) {
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
    call: TargetedCall,
    requestId: string,
    target: ResolvedTarget,
    view: WindowState | undefined,
  ): JsonValue | Promise<JsonValue> {
    if (
      !view ||
      (view.closed &&
        (call.operation !== "windows.getReadiness" ||
          target.suppliedId !== undefined))
    ) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Window is not open.",
      });
    }
    this.throwIfCancelled(requestId);
    return this.hooks.apply(call, target.viewId);
  }

  /** Create or recreate one window, reserving its slot until it is ready or the attempt fails. */
  private async createWindow(
    call: CreationCall,
    requestId: string,
    target: ResolvedTarget,
    view: WindowState | undefined,
  ): Promise<JsonValue> {
    const { spec, policyView, viewId, creationSpec } = target;
    if (
      (call.operation === "windows.create" ||
        call.operation === "windows.createInstance") &&
      view &&
      !view.closed
    ) {
      throw new BunawayError({
        code: "BUSY",
        message:
          "Window is already open. Only one window per view is supported; use show or recreate for the existing window.",
      });
    }
    if (
      call.operation === "windows.recreateInstance" &&
      (!view || view.closed)
    ) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Window lifetime is not open.",
      });
    }
    if (!view || view.cleaned) {
      this.checkCapacity(spec, viewId);
    }
    if (!creationSpec) {
      throw new Error("Missing resolved creation configuration.");
    }
    this.hooks.validateCreation?.(creationSpec);
    // Serialize create/recreate for this view until readiness or failure.
    this.replacing.add(viewId);
    this.reservedViews.set(viewId, policyView);
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
      // Do not create a replacement until the UI pump confirms native cleanup of the old view.
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
      return await this.awaitReadiness(
        requestId,
        viewId,
        closesLiveWindow,
        call.operation === "windows.createInstance" ||
          call.operation === "windows.recreateInstance",
      );
    } catch (error) {
      if (this.unreadyWindowNeedsDestroy(viewId, creationStarted)) {
        await this.hooks.destroy?.(viewId);
      }
      throw error;
    } finally {
      this.replacing.delete(viewId);
      this.reservedViews.delete(viewId);
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
   * Wait for controller setup, returning null or the new lifetime's identity.
   * Preserves create's existing completion at controller setup; document and SDK readiness are separate.
   */
  private async awaitReadiness(
    requestId: string,
    viewId: string,
    closesLiveWindow: boolean,
    returnsIdentity: boolean,
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
        return returnsIdentity ? this.identityOf(viewId) : null;
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

  /** The identity registered for a ready lifetime; a missing one is a platform bug. */
  private identityOf(viewId: string): JsonValue {
    const identity = this.hooks
      .instances?.()
      .find((entry) => entry.key === viewId)?.identity;
    if (!identity) {
      throw new Error("Native window identity was not registered.");
    }
    return {
      ...identity,
    };
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

  /** Resolve an explicit HWND lifetime against its policy view; multiple views never infer a target. */
  resolveKey(
    viewId: string,
    windowId?: string,
    allowMissing = false,
  ): string | undefined {
    const spec = this.specs.find((candidate) => candidate.view === viewId);
    if (!spec) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Window is not configured.",
      });
    }
    if (windowId === undefined) {
      if (spec.instances === "multiple") {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Multiple-window views require windowId.",
        });
      }
      return viewId;
    }
    const entry = this.hooks
      .instances?.()
      .find((entry) => entry.identity.windowId === windowId);
    if (entry && entry.identity.viewId !== viewId) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Window ID does not belong to the requested view.",
      });
    }
    if (entry) {
      return entry.key;
    }
    // Legacy adapters have no catalog and cannot authenticate explicit native IDs.
    if (!this.hooks.instances) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message:
          "Window identity targeting is not implemented on this platform.",
      });
    }
    if (allowMissing) {
      return undefined;
    }
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Window lifetime is not open.",
    });
  }

  /** Count reservations and native resources together before any asynchronous creation work. */
  private checkCapacity(spec: WindowSpec, key: string): void {
    const occupied = new Map<string, string>();
    for (const entry of this.hooks.instances?.() ?? []) {
      if (!this.hooks.read(entry.key)?.cleaned) {
        occupied.set(entry.key, entry.identity.viewId);
      }
    }
    // Single-window platforms without a catalog still count all live or cleaning declarations.
    if (!this.hooks.instances) {
      for (const definition of this.specs) {
        const state = this.hooks.read(definition.view);
        if (state && !state.cleaned) {
          occupied.set(definition.view, definition.view);
        }
      }
    }
    for (const reserved of this.replacing) {
      occupied.set(reserved, this.reservedViews.get(reserved) ?? reserved);
    }
    occupied.delete(key);
    const perView = [
      ...occupied.values(),
    ].filter((viewId) => viewId === spec.view).length;
    if (
      occupied.size >= MAX_WINDOW_INSTANCES ||
      perView >= (spec.maxInstances ?? 1)
    ) {
      throw new BunawayError({
        code: "BUSY",
        message: "Window instance limit reached.",
      });
    }
  }
}
