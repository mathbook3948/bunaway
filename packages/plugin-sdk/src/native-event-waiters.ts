import { BunawayError, type JsonValue } from "@bunaway/protocol";

/** Bounded one-shot native notifications. No history or app-residency ownership is retained. */
export class NativeEventWaiters<T extends JsonValue> {
  private readonly pending = new Set<{
    resolve(value: T): void;
    reject(error: BunawayError): void;
  }>();
  private disposed = false;

  constructor(private readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1) {
      throw new RangeError("Invalid native waiter limit.");
    }
  }
  /** Wait for the next published notification, rejecting on cancellation or adapter disposal. */
  wait(signal?: AbortSignal): Promise<T> {
    if (this.disposed || signal?.aborted) {
      return Promise.reject(this.cancelled());
    }
    if (this.pending.size >= this.maximum) {
      return Promise.reject(
        new BunawayError({
          code: "BUSY",
          message: "Native notification waiter limit reached.",
        }),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const finish = () => {
        this.pending.delete(waiter);
        signal?.removeEventListener("abort", aborted);
      };
      const waiter = {
        resolve(value: T) {
          finish();
          resolve(value);
        },
        reject(error: BunawayError) {
          finish();
          reject(error);
        },
      };
      const aborted = () => waiter.reject(this.cancelled());
      this.pending.add(waiter);
      signal?.addEventListener("abort", aborted, {
        once: true,
      });
    });
  }
  /** Broadcast a detached notification to current waiters only. Future waits receive no replay. */
  publish(value: T): void {
    for (const waiter of [
      ...this.pending,
    ]) {
      waiter.resolve(structuredClone(value));
    }
  }
  /** Reject every pending wait once. The owning adapter must call this during its cleanup. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const waiter of [
      ...this.pending,
    ]) {
      waiter.reject(this.cancelled());
    }
  }
  private cancelled(): BunawayError {
    return new BunawayError({
      code: "CANCELLED",
      message: "Native notification wait cancelled.",
    });
  }
}
