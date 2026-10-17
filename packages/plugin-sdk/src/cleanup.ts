/**
 * Shared cleanup policy for native plugin resources.
 *
 * Native adapters own several OS resources (library handles, HWNDs, COM apartments,
 * registrations) whose releases must all be attempted even when one fails, and whose
 * failures must reach the host together. These helpers hold that policy in one place:
 * every step runs, failures are collected, and one AggregateError reports them under a
 * message that names the owner.
 */

/**
 * Run every step in order even when one throws, then report all failures together as an
 * `AggregateError` with `message`. Steps that depend on an earlier step's success belong
 * in one step.
 */
export function attemptAll(steps: Iterable<() => void>, message: string): void {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, message);
  }
}

/** Like `attemptAll`, awaiting each step before starting the next. */
export async function attemptAllAsync(
  steps: Iterable<() => void | Promise<void>>,
  message: string,
): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, message);
  }
}

/**
 * Rethrow `error` after running `cleanup` for the work it interrupted. When the cleanup
 * fails as well, both failures are reported together under `message` so neither is lost.
 */
export function failWithCleanup(
  error: unknown,
  cleanup: () => void,
  message: string,
): never {
  try {
    cleanup();
  } catch (cleanupError) {
    throw new AggregateError(
      [
        error,
        cleanupError,
      ],
      message,
    );
  }
  throw error;
}

/**
 * Owns resources acquired in sequence and releases them in reverse order exactly once.
 *
 * `acquire` registers each resource with its release; when a later acquisition throws,
 * the owner releases everything acquired so far and rethrows, so a half-initialized
 * adapter never leaks. `dispose` releases every resource even when one release fails and
 * reports the failures together; repeated calls do nothing.
 */
export class ResourceOwner {
  private readonly releases: (() => void)[] = [];
  private state: "active" | "disposed" = "active";

  /** `failureMessage` names the owner in the AggregateError a failed disposal throws. */
  constructor(private readonly failureMessage: string) {}

  /** Whether `dispose` has run; operations on a disposed owner's resources must refuse. */
  get disposed(): boolean {
    return this.state === "disposed";
  }

  /** Create a resource and own its release; a failed creation disposes the owner first. */
  acquire<T>(create: () => T, release: (resource: T) => void): T {
    if (this.disposed) {
      throw new Error("Cannot acquire a resource after disposal.");
    }
    let resource: T;
    try {
      resource = create();
    } catch (error) {
      failWithCleanup(error, () => this.dispose(), this.failureMessage);
    }
    this.releases.push(() => release(resource));
    return resource;
  }

  /** Release every owned resource in reverse order; later calls do nothing. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.state = "disposed";
    attemptAll(this.releases.splice(0).reverse(), this.failureMessage);
  }
}
