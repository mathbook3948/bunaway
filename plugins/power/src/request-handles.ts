import { BunawayError } from "@bunaway/protocol";
import { MAX_POWER_BLOCKERS, type PowerBlockerType } from "./contract.ts";

const POWER_REQUEST_DISPLAY_REQUIRED = 0;
const POWER_REQUEST_SYSTEM_REQUIRED = 1;
export type PowerRequestBindings = {
  create(reason: string): bigint;
  set(handle: bigint, type: number): boolean;
  clear(handle: bigint, type: number): boolean;
  close(handle: bigint): boolean;
};

function failure(message: string): never {
  throw new BunawayError({
    code: "INTERNAL",
    message,
  });
}

/** Own native power request objects, including unregistered objects after failed activation. */
export class PowerRequestHandles {
  private readonly handles = new Map<bigint, number[]>();
  constructor(private readonly bindings: PowerRequestBindings) {}

  /** Display requests also prevent system idle sleep. Roll back partial activation before reporting failure. */
  start(type: PowerBlockerType, reason: string): bigint {
    if (this.handles.size >= MAX_POWER_BLOCKERS) {
      throw new BunawayError({
        code: "BUSY",
        message: "Power request capacity reached.",
      });
    }
    const handle = this.bindings.create(reason);
    const active: number[] = [];
    this.handles.set(handle, active);
    try {
      const types =
        type === "display"
          ? [
              POWER_REQUEST_SYSTEM_REQUIRED,
              POWER_REQUEST_DISPLAY_REQUIRED,
            ]
          : [
              POWER_REQUEST_SYSTEM_REQUIRED,
            ];
      for (const requestType of types) {
        if (!this.bindings.set(handle, requestType)) {
          failure("Windows power request activation failed.");
        }
        active.push(requestType);
      }
      return handle;
    } catch (error) {
      try {
        this.stop(handle);
      } catch (cleanup) {
        throw new AggregateError(
          [
            error,
            cleanup,
          ],
          "Windows power request activation and cleanup failed.",
        );
      }
      throw error;
    }
  }

  /** Closing the request object releases it even if Windows already terminated its counts at sleep. */
  stop(handle: bigint): void {
    const active = this.handles.get(handle);
    if (!active) {
      return;
    }
    for (const type of active) {
      // PowerClearRequest can report no count after user-initiated sleep. CloseHandle
      // is the authoritative resource release, so a failed clear does not prevent it.
      this.bindings.clear(handle, type);
    }
    active.length = 0;
    if (!this.bindings.close(handle)) {
      failure("Windows power request handle cleanup failed.");
    }
    this.handles.delete(handle);
  }

  /** Attempt every cleanup and retain failed closes for a subsequent disposal attempt. */
  dispose(): void {
    const errors: unknown[] = [];
    for (const handle of this.handles.keys()) {
      try {
        this.stop(handle);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "Windows power request cleanup failed.");
    }
  }
}
