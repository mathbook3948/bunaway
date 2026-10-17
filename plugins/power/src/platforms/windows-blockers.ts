import { attemptAll } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import {
  MAX_POWER_BLOCKERS,
  type PowerBlocker,
  type PowerBlockerType,
} from "#power/contract";

export { MAX_POWER_BLOCKERS } from "#power/contract";
export type PowerRequestNative = {
  start(type: PowerBlockerType, reason: string): bigint;
  stop(handle: bigint): void;
};
/** Own independently releasable native requests, including retries after failed cleanup. */
export class PowerBlockers {
  private readonly requests = new Map<
    string,
    {
      handle: bigint;
      type: PowerBlockerType;
    }
  >();
  private disposing = false;
  constructor(private readonly native: PowerRequestNative) {}

  /** Reserve no public ID until all native request types have been activated. */
  start(type: PowerBlockerType, reason: string): PowerBlocker {
    if (this.disposing) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Power adapter is disposed.",
      });
    }
    if (this.requests.size >= MAX_POWER_BLOCKERS) {
      throw new BunawayError({
        code: "BUSY",
        message: "Power blocker capacity reached.",
      });
    }
    const id = crypto.randomUUID();
    const handle = this.native.start(type, reason);
    this.requests.set(id, {
      handle,
      type,
    });
    return {
      id,
      type,
    };
  }
  /** List only this adapter's registered requests, never OS-wide power requests. */
  list(): PowerBlocker[] {
    return [
      ...this.requests,
    ].map(([id, { type }]) => ({
      id,
      type,
    }));
  }
  active(id: string): boolean {
    return this.requests.has(id);
  }
  /** Unknown or already stopped IDs return false. Failed release retains the ID for retry. */
  stop(id: string): boolean {
    const request = this.requests.get(id);
    if (!request) {
      return false;
    }
    this.native.stop(request.handle);
    this.requests.delete(id);
    return true;
  }
  /** Prevent new starts and attempt every release. A failed disposal can be retried. */
  dispose(): void {
    this.disposing = true;
    attemptAll(
      [
        ...this.requests.keys(),
      ].map((id) => () => this.stop(id)),
      "Power request cleanup failed.",
    );
  }
}
