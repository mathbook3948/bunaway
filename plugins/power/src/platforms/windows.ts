import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import type { blockerInputSchema } from "#power/contract";
import { createPower } from "#power/platforms/windows-bindings";
import { PowerBlockers } from "#power/platforms/windows-blockers";
/** Own DLLs and power request handles on the host I/O worker. */
export class WindowsPower {
  private readonly native = createPower();
  private readonly blockers = new PowerBlockers(this.native);
  private disposed = false;

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

  /** Retry both owners independently so one failed close does not skip the other. */
  dispose(): void {
    this.disposed = true;
    const errors: unknown[] = [];
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

export function initialize(): WindowsPower {
  return new WindowsPower();
}

export function dispose(instance: WindowsPower): void {
  instance.dispose();
}
