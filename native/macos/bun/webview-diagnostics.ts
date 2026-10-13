const MAX_STAGE_RECORDS = 64;
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
  | "response-policy"
  | "provisional"
  | "committed"
  | "finished"
  | "provisional-failed"
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
