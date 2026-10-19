import type { WebviewProbe } from "./webview-probe.ts";

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
  | "load-stopped"
  | "view-recreated"
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
 * report must not depend on it. `check` runs on scan ticks, so a reissue interval is `PROVISIONAL_STALL_MS`
 * plus up to one tick. The slow-decision protection covers the first request only: a reissued load
 * whose decision takes longer than the threshold is reissued again, within the same retry budget.
 */
export class StalledLoadClock {
  private allowedAt: number | undefined;
  private attempts = 0;
  private reissued = false;

  /**
   * A load request was sent. A new request waits for its policy decision before a stall is
   * measured; the request that follows a "retry" keeps the clock `check` restarted.
   */
  requested(): void {
    if (this.reissued) {
      this.reissued = false;
      return;
    }
    this.allowedAt = undefined;
  }

  /** The policy allowed the load. Only the first decision after `requested` starts the clock. */
  policyAllowed(now: number): void {
    if (this.allowedAt === undefined) {
      this.allowedAt = now;
    }
  }

  /**
   * Start the clock without a policy decision, for a view that replaces a stalled one: its load may
   * stall before the policy callback, and the stall must still be reported. The `requested` call
   * for the load that follows keeps this start.
   */
  startNow(now: number): void {
    this.allowedAt = now;
    this.reissued = true;
  }

  /** A reload after a WebContent crash gets a fresh retry budget. */
  resetBudget(): void {
    this.attempts = 0;
    this.reissued = false;
  }

  /**
   * Decide what to do now for a load whose provisional navigation has not started. On "retry" the
   * clock restarts from `now` and the `requested` call for the reissued load keeps it.
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
      this.reissued = true;
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
      /** `loadRequest:` returned the same object address as the previous request (an address can be reused after release). */
      sameNavigation?: boolean;
      probe?: WebviewProbe | undefined;
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
    const { probe, ...rest } = fields;
    this.log("webview-stage", {
      stage,
      ...rest,
      ...probe,
    });
  }
}
