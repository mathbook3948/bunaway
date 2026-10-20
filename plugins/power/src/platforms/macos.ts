import {
  attemptAll,
  failWithCleanup,
  type NativeEnvironment,
} from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import { PowerBlockers } from "#power/blockers";
import type { blockerInputSchema, MacosPowerInstance } from "#power/contract";
import { createMacosPower } from "#power/platforms/macos-bindings";
import {
  createMacosAssertions,
  type MacosAssertions,
} from "#power/platforms/macos-blockers";
import { watchMacosPowerLifecycle } from "#power/platforms/macos-lifecycle-events";

/**
 * Power queries and app-owned sleep requests on macOS: power source and battery status, the input
 * idle time, IOPMAssertion requests that keep the system or display awake, and the sleep, wake,
 * screen lock and screen unlock events. `power.statusChanged` and the CPU speed limit are not
 * implemented and stay unsupported.
 */
export class MacosPower implements MacosPowerInstance {
  private readonly native = createMacosPower();
  private readonly assertions: MacosAssertions;
  private readonly blockers: PowerBlockers;
  private readonly releaseLifecycleEvents: (() => void) | undefined;
  private disposed = false;

  constructor(events?: NativeEnvironment["events"]) {
    try {
      this.assertions = createMacosAssertions();
    } catch (error) {
      // No caller receives the adapter, so release the query bindings opened above here.
      failWithCleanup(
        error,
        () => this.native.dispose(),
        "Power adapter cleanup failed.",
      );
    }
    this.blockers = new PowerBlockers(this.assertions);
    try {
      this.releaseLifecycleEvents = watchMacosPowerLifecycle(events);
    } catch (error) {
      failWithCleanup(
        error,
        () => this.dispose(),
        "Power adapter cleanup failed.",
      );
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
    return this.native.status();
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
    return this.blockers.start(input.type, input.reason);
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
   * Stop the event observers first so nothing is emitted while the rest is released, then release
   * every assertion before the libraries that release them are closed. Each owner is
   * attempted even when an earlier one fails, and a repeated call retries what remains.
   */
  dispose(): void {
    this.disposed = true;
    attemptAll(
      [
        () => this.releaseLifecycleEvents?.(),
        () => this.blockers.dispose(),
        () => this.assertions.dispose(),
        () => this.native.dispose(),
      ],
      "Power adapter cleanup failed.",
    );
  }
}

export function initialize(environment: NativeEnvironment): MacosPower {
  return new MacosPower(environment.events);
}

export function dispose(instance: MacosPower): void {
  instance.dispose();
}
