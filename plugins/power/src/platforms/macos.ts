import { BunawayError } from "@bunaway/protocol";
import type { PowerQueries } from "#power/contract";
import { createMacosPower } from "#power/platforms/macos-bindings";

/**
 * Read-only power queries on macOS: power source and battery status and the input idle time.
 * Events, power blockers and the CPU speed limit are not implemented and stay unsupported.
 */
export class MacosPower implements PowerQueries {
  private readonly native = createMacosPower();
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

  /** Safe to repeat: the native owner releases once and a failed release is reported to the caller. */
  dispose(): void {
    this.disposed = true;
    this.native.dispose();
  }
}

export function initialize(): MacosPower {
  return new MacosPower();
}

export function dispose(instance: MacosPower): void {
  instance.dispose();
}
