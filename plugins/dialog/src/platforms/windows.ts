import type { NativeEnvironment } from "@bunaway/plugin";
import type { NativeDialogServices } from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";
import type {
  DialogInput,
  DialogInstance,
  DialogKind,
  DialogResult,
  MessageInput,
  MessageResult,
} from "#dialog/contract";
import { createDialog } from "#dialog/platforms/windows-bindings";
import { createMessageDialog } from "#dialog/platforms/windows-message-bindings";

/**
 * One native modal call owns its OS references until the modal stack has unwound.
 *
 * `poll` drains host control packets and returns true once the call must be abandoned; the driver then
 * closes its dialog and `WindowsDialogs` discards any result in favor of a CANCELLED error.
 */
export type DialogDriver<Result = DialogResult> = {
  show(owner: bigint, poll: () => boolean): Result;
  dispose(): void;
};
export type DialogFactory = (
  kind: DialogKind,
  input: DialogInput,
  services: NativeDialogServices,
) => DialogDriver;
export type MessageDialogFactory = (
  input: MessageInput,
  services: NativeDialogServices,
) => DialogDriver<MessageResult>;

/** Own a picker lifetime; cancellation never becomes a successful user dismissal. */
export class WindowsDialogs implements DialogInstance {
  private disposed = false;
  private active = false;
  constructor(
    private readonly services: NativeDialogServices | undefined,
    private readonly create: DialogFactory = createDialog,
    private readonly createMessage: MessageDialogFactory = createMessageDialog,
  ) {}

  show(
    kind: DialogKind,
    input: DialogInput,
    source: string,
    signal?: AbortSignal,
    requestId?: string,
  ): DialogResult {
    return this.run(
      input.ownerWindowId,
      source,
      signal,
      requestId,
      (services) => this.create(kind, input, services),
      {
        cancelFailureAfterInterrupt: false,
      },
    );
  }

  /** Show a message or confirmation dialog under the same queue, owner and cancellation rules as pickers. */
  showMessage(
    input: MessageInput,
    source: string,
    signal?: AbortSignal,
    requestId?: string,
  ): MessageResult {
    return this.run(
      input.ownerWindowId,
      source,
      signal,
      requestId,
      (services) => this.createMessage(input, services),
      {
        cancelFailureAfterInterrupt: true,
      },
    );
  }

  /**
   * Shared lifecycle for every modal dialog: authorize the owner, guard re-entry, watch host
   * cancellation, run the driver and dispose it. Host cancellation always surfaces as CANCELLED,
   * even when the native dialog completed with a user result.
   *
   * `cancelFailureAfterInterrupt` is a message-dialog-only policy. A TaskDialog is force-closed after
   * host interruption and that close can produce a native failure, so for messages such a failure
   * becomes CANCELLED with the native error kept as `cause`. Pickers leave it false and keep
   * surfacing native Close failures unchanged.
   */
  private run<Result>(
    requestedOwnerWindowId: string | undefined,
    source: string,
    signal: AbortSignal | undefined,
    requestId: string | undefined,
    create: (services: NativeDialogServices) => DialogDriver<Result>,
    options: {
      cancelFailureAfterInterrupt: boolean;
    },
  ): Result {
    const services = this.services;
    if (!services) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Native dialog services are unavailable.",
      });
    }
    const cancelled = () =>
      this.disposed || signal?.aborted || services.stopping();
    const cancelledCall = () =>
      new BunawayError({
        code: "CANCELLED",
        message: "Dialog call was cancelled.",
      });
    const checkCancelled = () => {
      if (cancelled()) {
        throw cancelledCall();
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
    let ownerWindowId = requestedOwnerWindowId;
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
    let driver: DialogDriver<Result> | undefined;
    let interrupted = false;
    try {
      driver = create(services);
      const interruptedByHost = () =>
        interrupted ||
        !!cancelled() ||
        cancellation.cancelled() ||
        !!(owner && !owner.alive());
      const cancelledByHost = () =>
        new BunawayError({
          code: "CANCELLED",
          message: "Dialog owner closed or call was cancelled.",
        });
      let result: Result;
      try {
        result = driver.show(owner?.hwnd ?? 0n, () => {
          services.poll();
          // Latched: once the host interrupts, the dialog stays interrupted even if the owner state flips back.
          interrupted = interruptedByHost();
          return interrupted;
        });
      } catch (error) {
        if (!options.cancelFailureAfterInterrupt || !interruptedByHost()) {
          throw error;
        }
        // The driver force-closes its dialog after host interruption, so this native failure is a
        // consequence of that close and the caller must see the cancellation, with the failure as cause.
        const failure = cancelled() ? cancelledCall() : cancelledByHost();
        failure.cause = error;
        throw failure;
      }
      checkCancelled();
      if (interruptedByHost()) {
        throw cancelledByHost();
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
