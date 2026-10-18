const MAX_STAGE_RECORDS = 64;
/** A load request that has not started its provisional navigation after this long is reissued. */
export const PROVISIONAL_STALL_MS = 3000;
/** Reissues per view (a reload after a WebContent crash starts over); the document and SDK deadlines (30 s) still bound the total wait. */
export const MAX_LOAD_RETRIES = 3;
const ERROR_DOMAINS = [
  "WKErrorDomain",
  "NSURLErrorDomain",
  "NSCocoaErrorDomain",
  "NSPOSIXErrorDomain",
] as const;

type Stage =
  | "created"
  | "rules-ready"
  | "rules-failed"
  | "load-requested"
  | "load-returned"
  | "action-policy"
  | "action-policy-returned"
  | "response-policy"
  | "response-policy-returned"
  | "provisional"
  | "committed"
  | "finished"
  | "provisional-failed"
  | "load-retried"
  | "load-stalled"
  | "navigation-failed"
  | "asset-started"
  | "asset-finished"
  | "asset-stopped"
  | "script-message"
  | "provisional-message-ignored"
  | "origin-message-ignored"
  | "delivery-completed"
  | "process-terminated"
  | "closed"
  | "startup-checkpoint";

/** Copy only a known system domain and signed code; NSError userInfo is never inspected. */
export function webviewError(domain: string, code: number | bigint) {
  const number = Number(code);
  return {
    errorDomain: ERROR_DOMAINS.find((known) => known === domain) ?? "other",
    errorCode: Number.isSafeInteger(number) ? number : null,
  };
}

/**
 * What to do about a load request whose provisional navigation has not started.
 * `attempts` counts reissues so far, plus one once the stall has been reported.
 */
export function stalledLoadAction(
  sinceLoadMs: number,
  attempts: number,
): "wait" | "retry" | "report" | "none" {
  if (sinceLoadMs < PROVISIONAL_STALL_MS) {
    return "wait";
  }
  if (attempts < MAX_LOAD_RETRIES) {
    return "retry";
  }
  return attempts === MAX_LOAD_RETRIES ? "report" : "none";
}

/**
 * Stall clock for one view's load requests. The clock starts when the navigation policy allows the
 * load (so a slow decision is never mistaken for a stalled navigation) and restarts at every
 * reissue: a reissued load may never reach the policy callback, so the next retry and the final
 * report must not depend on it. Each reissue interval is therefore `PROVISIONAL_STALL_MS`.
 */
export class StalledLoadClock {
  private allowedAt: number | undefined;
  private attempts = 0;

  /** A new load request was sent; wait for its policy decision before measuring a stall. */
  requested(): void {
    this.allowedAt = undefined;
  }

  /** The policy allowed the load. Only the first decision after `requested` starts the clock. */
  policyAllowed(now: number): void {
    if (this.allowedAt === undefined) {
      this.allowedAt = now;
    }
  }

  /** A reload after a WebContent crash gets a fresh retry budget. */
  resetBudget(): void {
    this.attempts = 0;
  }

  /**
   * Decide what to do now for a load whose provisional navigation has not started. On "retry" the
   * clock restarts from `now` and the caller reissues the request without calling `requested`.
   */
  check(now: number): ReturnType<typeof stalledLoadAction> {
    if (this.allowedAt === undefined) {
      return "wait";
    }
    const action = stalledLoadAction(now - this.allowedAt, this.attempts);
    if (action === "retry" || action === "report") {
      this.attempts++;
    }
    if (action === "retry") {
      this.allowedAt = now;
    }
    return action;
  }
}

/** Bounded per-window native progress, independent of URLs, payloads and the SDK route. */
export class WebviewDiagnostics {
  private count = 0;
  constructor(private readonly log: (event: string, fields: object) => void) {}

  record(
    stage: Stage,
    fields: {
      allowed?: boolean;
      accepted?: boolean;
      status?: number;
      loading?: boolean;
      provisional?: boolean;
      progress?: number;
      errorDomain?: ReturnType<typeof webviewError>["errorDomain"];
      errorCode?: number | null;
    } = {},
  ): void {
    if (this.count >= MAX_STAGE_RECORDS) {
      return;
    }
    this.count++;
    if (this.count === MAX_STAGE_RECORDS) {
      this.log("webview-stage", {
        stage: "limit",
      });
      return;
    }
    this.log("webview-stage", {
      stage,
      ...fields,
    });
  }
}
