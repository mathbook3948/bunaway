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
