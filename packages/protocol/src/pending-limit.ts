/** Default number of requests one session may have waiting at once. */
export const DEFAULT_MAX_PENDING = 128;

/** Largest value an app may configure for the pending request limit. */
export const MAX_PENDING_CEILING = 1024;

/**
 * Resolves the pending request limit from a policy or hello that may omit it.
 * Both documents are schema-validated, so a present value is already inside
 * the configurable range.
 */
export function resolveMaxPending(
  source:
    | {
        readonly maxPending?: number;
      }
    | undefined,
): number {
  return source?.maxPending ?? DEFAULT_MAX_PENDING;
}
