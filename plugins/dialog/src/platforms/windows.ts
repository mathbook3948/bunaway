import type { NativeEnvironment } from "@bunaway/plugin";
import type { NativeDialogServices } from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";
import type { DialogInput, DialogKind, DialogResult } from "#dialog/contract";
import { createDialog } from "#dialog/platforms/windows-bindings";

/** One native Show call owns its COM references until the modal stack has unwound. */
export type DialogDriver = {
  show(owner: bigint, poll: () => boolean): DialogResult;
  dispose(): void;
};
export type DialogFactory = (
  kind: DialogKind,
  input: DialogInput,
  services: NativeDialogServices,
) => DialogDriver;

/** Own a picker lifetime; cancellation never becomes a successful user dismissal. */
export class WindowsDialogs {
  private disposed = false;
  private active = false;
  constructor(
    private readonly services: NativeDialogServices | undefined,
    private readonly create: DialogFactory = createDialog,
  ) {}

  show(
    kind: DialogKind,
    input: DialogInput,
    source: string,
    signal?: AbortSignal,
    requestId?: string,
  ): DialogResult {
    const services = this.services;
    if (!services) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Native dialog services are unavailable.",
      });
    }
    const cancelled = () =>
      this.disposed || signal?.aborted || services.stopping();
    const checkCancelled = () => {
      if (cancelled()) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Dialog call was cancelled.",
        });
      }
    };
    checkCancelled();
    // Normal host requests serialize while Show owns the STA. Guard accidental native re-entry too.
    if (this.active) {
      throw new BunawayError({
        code: "BUSY",
        message: "A dialog is already open.",
      });
    }
    let ownerWindowId = input.ownerWindowId;
    if (source !== "backend") {
      const origin = requestId ? services.origin(requestId) : null;
      if (
        !origin ||
        source !== `view:${origin.viewId}` ||
        (ownerWindowId !== undefined && ownerWindowId !== origin.windowId)
      ) {
        throw new BunawayError({
          code: "PERMISSION_DENIED",
          message: "A view may open dialogs only for its originating window.",
        });
      }
      ownerWindowId = origin.windowId;
    }
    const owner = ownerWindowId ? services.owner(ownerWindowId) : null;
    if (ownerWindowId && !owner?.alive()) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Dialog owner window is no longer live.",
      });
    }
    const cancellation = services.watchCancellation(requestId);
    this.active = true;
    let driver: DialogDriver | undefined;
    let interrupted = false;
    try {
      driver = this.create(kind, input, services);
      const result = driver.show(owner?.hwnd ?? 0n, () => {
        services.poll();
        interrupted ||=
          !!cancelled() ||
          cancellation.cancelled() ||
          !!(owner && !owner.alive());
        return interrupted;
      });
      checkCancelled();
      if (
        interrupted ||
        cancellation.cancelled() ||
        (owner && !owner.alive())
      ) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Dialog owner closed or call was cancelled.",
        });
      }
      return result;
    } finally {
      try {
        driver?.dispose();
      } finally {
        cancellation.dispose();
        this.active = false;
      }
    }
  }
  busy(): boolean {
    return this.active;
  }
  /** Native references stay with Show's finally block if disposal is requested reentrantly. */
  dispose(): void {
    this.disposed = true;
  }
}
export function initialize(environment: NativeEnvironment): WindowsDialogs {
  return new WindowsDialogs(environment.dialogs);
}
export function dispose(instance: WindowsDialogs): void {
  instance.dispose();
}
export function busy(instance: WindowsDialogs): boolean {
  return instance.busy();
}
