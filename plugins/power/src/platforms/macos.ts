import { attemptAll, failWithCleanup } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import { PowerBlockers } from "#power/blockers";
import type { blockerInputSchema, MacosPowerInstance } from "#power/contract";
import { createMacosPower } from "#power/platforms/macos-bindings";
import {
  createMacosAssertions,
  type MacosAssertions,
} from "#power/platforms/macos-blockers";

/**
 * Power queries and app-owned sleep requests on macOS: power source and battery status, the input
 * idle time, and IOPMAssertion requests that keep the system or display awake. Events and the CPU
 * speed limit are not implemented and stay unsupported.
 */
export class MacosPower implements MacosPowerInstance {
  private readonly native = createMacosPower();
  private readonly assertions: MacosAssertions;
  private readonly blockers: PowerBlockers;
  private disposed = false;

  constructor() {
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
   * Release every assertion before the libraries that release them are closed. Each owner is
   * attempted even when an earlier one fails, and a repeated call retries what remains.
   */
  dispose(): void {
    this.disposed = true;
    attemptAll(
      [
        () => this.blockers.dispose(),
        () => this.assertions.dispose(),
        () => this.native.dispose(),
      ],
      "Power adapter cleanup failed.",
    );
  }
}

export function initialize(): MacosPower {
  return new MacosPower();
}

export function dispose(instance: MacosPower): void {
  instance.dispose();
}
