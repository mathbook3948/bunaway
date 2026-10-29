import { attemptAll, type NativeEnvironment } from "@bunaway/plugin";
import type { NativeSystemEvents } from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import { PowerBlockers } from "#power/blockers";
import type { blockerInputSchema } from "#power/contract";
import { createPower } from "#power/platforms/windows-bindings";
import { watchPowerLifecycle } from "#power/platforms/windows-lifecycle-events";
import { watchPowerStatus } from "#power/platforms/windows-status-events";
/** Own DLLs, power request handles and the status change subscription on the UI thread. */
export class WindowsPower {
  private readonly native = createPower();
  private readonly blockers = new PowerBlockers(this.native);
  private releaseStatusEvents: (() => void) | undefined;
  private releaseLifecycleEvents: (() => void) | undefined;
  private disposed = false;

  /** Status events are optional: hosts without system event services still answer queries. */
  constructor(
    systemEvents?: Pick<NativeSystemEvents, "subscribe" | "publish">,
  ) {
    try {
      // Lifecycle subscribes first, so hosts that call subscribers in order publish power.resumed first.
      this.releaseLifecycleEvents = watchPowerLifecycle(systemEvents);
      this.releaseStatusEvents = watchPowerStatus(
        () => this.native.status(),
        systemEvents,
      );
    } catch (error) {
      // Construction failed, so no caller can dispose the native resources.
      const failures: unknown[] = [];
      try {
        this.releaseLifecycleEvents?.();
      } catch (cleanup) {
        failures.push(cleanup);
      }
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

  getCpuSpeedLimit() {
    this.active();
    return this.native.cpuSpeedLimit();
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

  isSessionLocked() {
    this.active();
    return {
      locked: this.native.sessionLocked(),
    };
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
    attemptAll(
      [
        () => {
          this.releaseStatusEvents?.();
          this.releaseStatusEvents = undefined;
        },
        () => {
          this.releaseLifecycleEvents?.();
          this.releaseLifecycleEvents = undefined;
        },
        () => this.blockers.dispose(),
        // Failed activation can retain a native handle without a public blocker ID.
        () => this.native.dispose(),
      ],
      "Power adapter cleanup failed.",
    );
  }
}

export function initialize(environment: NativeEnvironment): WindowsPower {
  return new WindowsPower(environment.windows?.systemEvents);
}

export function dispose(instance: WindowsPower): void {
  instance.dispose();
}
