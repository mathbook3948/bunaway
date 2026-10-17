import type { NativeEnvironment } from "@bunaway/plugin";
import type { NativeSystemEvents } from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import type { blockerInputSchema } from "#power/contract";
import { createPower } from "#power/platforms/windows-bindings";
import { PowerBlockers } from "#power/platforms/windows-blockers";
import { watchPowerStatus } from "#power/platforms/windows-status-events";
/** Own DLLs, power request handles and the status change subscription on the UI thread. */
export class WindowsPower {
  private readonly native = createPower();
  private readonly blockers = new PowerBlockers(this.native);
  private releaseStatusEvents: (() => void) | undefined;
  private disposed = false;

  /** Status events are optional: hosts without system event services still answer queries. */
  constructor(
    systemEvents?: Pick<NativeSystemEvents, "subscribe" | "publish">,
  ) {
    try {
      this.releaseStatusEvents = watchPowerStatus(
        () => this.native.status(),
        systemEvents,
      );
    } catch (error) {
      // Construction failed, so no caller can dispose the native resources.
      const failures: unknown[] = [];
      try {
        this.blockers.dispose();
      } catch (cleanup) {
        failures.push(cleanup);
      }
      try {
        this.native.dispose();
      } catch (cleanup) {
        failures.push(cleanup);
      }
      if (failures.length) {
        throw new AggregateError(
          [
            error,
            ...failures,
          ],
          "Power adapter initialization and cleanup failed.",
        );
      }
      throw error;
    }
  }

  private active(): void {
    if (this.disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Power adapter is disposed.",
      });
    }
  }

  getStatus() {
    this.active();
    return {
      ...this.native.status(),
    };
  }

  getIdleTime() {
    this.active();
    return this.native.idle();
  }

  getIdleState(thresholdSeconds: number) {
    return this.getIdleTime() >= thresholdSeconds
      ? ("idle" as const)
      : ("active" as const);
  }

  startBlocker(input: z.output<typeof blockerInputSchema>) {
    this.active();
    return {
      ...this.blockers.start(input.type, input.reason),
    };
  }

  listBlockers() {
    this.active();
    return this.blockers.list();
  }

  isBlockerActive(id: string) {
    this.active();
    return this.blockers.active(id);
  }

  stopBlocker(id: string) {
    this.active();
    return this.blockers.stop(id);
  }

  /**
   * Retry every owner independently so one failed close does not skip another.
   * The subscription is released first so no refresh reads a disposed native binding.
   */
  dispose(): void {
    this.disposed = true;
    const errors: unknown[] = [];
    try {
      this.releaseStatusEvents?.();
      this.releaseStatusEvents = undefined;
    } catch (error) {
      errors.push(error);
    }
    try {
      this.blockers.dispose();
    } catch (error) {
      errors.push(error);
    }
    try {
      // Failed activation can retain a native handle without a public blocker ID.
      this.native.dispose();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) {
      throw new AggregateError(errors, "Power adapter cleanup failed.");
    }
  }
}

export function initialize(environment: NativeEnvironment): WindowsPower {
  return new WindowsPower(environment.windows?.systemEvents);
}

export function dispose(instance: WindowsPower): void {
  instance.dispose();
}
