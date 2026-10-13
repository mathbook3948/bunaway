import {
  MAX_WINDOW_INSTANCES,
  type NativeWindowServices,
  type WindowSpec,
} from "@bunaway/plugin-api/native";
import { BunawayError, type JsonValue } from "@bunaway/protocol";
import type { WindowCall } from "./contract.ts";
import { mergeCreationOptions } from "./creation-options.ts";

const WINDOW_CLEANUP_TIMEOUT_MS = 35_000;

export type { WindowState } from "@bunaway/plugin-api/native";

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
    if (
      call.operation === "windows.list" ||
      call.operation === "windows.listInstances"
    ) {
      if (this.hooks.stopping() || this.hooks.cancelled(requestId)) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Window request cancelled.",
        });
      }
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
    if (!call.payload || !("view" in call.payload)) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Expected a window operation.",
      });
    }
    const policyView = call.payload.view;
    const spec = this.specs.find((spec) => spec.view === policyView);
    if (!spec) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Window is not configured.",
      });
    }
    const creationSpec =
      call.operation === "windows.create" ||
      call.operation === "windows.recreate" ||
      call.operation === "windows.createInstance" ||
      call.operation === "windows.recreateInstance"
        ? mergeCreationOptions(spec, call.payload.options)
        : undefined;
    if (
      creationSpec &&
      call.payload &&
      "options" in call.payload &&
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
    if (
      call.operation === "windows.completeSplashscreen" &&
      (spec.instances === "multiple" ||
        this.specs.find((candidate) => candidate.view === call.payload.splash)
          ?.instances === "multiple")
    ) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Splashscreen handoff requires single-window views.",
      });
    }
    const suppliedId =
      "windowId" in call.payload ? call.payload.windowId : undefined;
    let viewId: string;
    if (
      call.operation === "windows.createInstance" &&
      spec.instances === "multiple"
    ) {
      viewId = `instance-${crypto.randomUUID()}`;
    } else {
      const resolved = this.resolveKey(
        policyView,
        suppliedId,
        call.operation === "windows.isDestroyed",
      );
      if (resolved === undefined) {
        return true;
      }
      viewId = resolved;
    }
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
    let view = this.hooks.read(viewId);
    if (call.operation === "windows.destroy") {
      if (this.hooks.stopping() || this.hooks.cancelled(requestId)) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Window request cancelled.",
        });
      }
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
      call.operation !== "windows.recreate" &&
      call.operation !== "windows.createInstance" &&
      call.operation !== "windows.recreateInstance"
    ) {
      if (
        !view ||
        (view.closed &&
          (call.operation !== "windows.getReadiness" ||
            suppliedId !== undefined))
      ) {
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
      return this.hooks.apply(call, viewId);
    }
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
          this.destroyedReplacements.has(viewId) ||
          (closesLiveWindow && view.replacementCancelled) ||
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
        this.destroyedReplacements.has(viewId) ||
        (closesLiveWindow && view?.replacementCancelled) ||
        (!closesLiveWindow && this.hooks.cancelled(requestId))
      ) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Window request cancelled.",
        });
      }
      // Once close commits, finish replacement even if the old document's context is revoked.
      creationStarted = true;
      this.hooks.create(creationSpec, closesLiveWindow, viewId);
      view = this.hooks.read(viewId);
      // Preserve create's existing completion at controller setup; document and SDK readiness are separate.
      while (true) {
        if (
          this.hooks.stopping() ||
          this.destroyedReplacements.has(viewId) ||
          view?.replacementCancelled
        ) {
          throw new BunawayError({
            code: "CANCELLED",
            message: "Window creation was cancelled.",
          });
        }
        if (!closesLiveWindow && this.hooks.cancelled(requestId)) {
          if (view && !view.closed) {
            await (this.hooks.destroy ?? this.hooks.close)(viewId);
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
          (!view.ready && this.hooks.now() > view.deadline)
        ) {
          throw new BunawayError({
            code: "INTERNAL",
            message: "Window creation failed.",
          });
        }
        // Readiness and termination can both arrive before this request resumes.
        if (view.ready) {
          if (!returnsIdentity) {
            return null;
          }
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
        await this.hooks.tick();
        view = this.hooks.read(viewId);
      }
    } catch (error) {
      const current = this.hooks.read(viewId);
      if (
        creationStarted &&
        current &&
        !current.closed &&
        !current.ready &&
        this.hooks.destroy
      ) {
        await this.hooks.destroy(viewId);
      }
      throw error;
    } finally {
      this.replacing.delete(viewId);
      this.reservedViews.delete(viewId);
      this.destroyedReplacements.delete(viewId);
      this.hooks.creationSettled?.(viewId);
    }
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
