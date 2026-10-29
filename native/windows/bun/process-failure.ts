import type {
  WindowProcessFailureEvent,
  WindowProcessFailureKind,
} from "@bunaway/plugin-api/native";

/** COREWEBVIEW2_PROCESS_FAILED_KIND values by number; an unlisted value reports `unknown-exited`. */
const PROCESS_FAILURE_KINDS: readonly WindowProcessFailureKind[] = [
  "browser-exited",
  "renderer-exited",
  "renderer-unresponsive",
  "frame-renderer-exited",
  "utility-exited",
  "sandbox-helper-exited",
  "gpu-exited",
  "plugin-exited",
  "plugin-broker-exited",
  "unknown-exited",
];

/** The kind number of `unknown-exited`; also stands in for a kind that could not be read. */
export const UNKNOWN_PROCESS_FAILED_KIND =
  PROCESS_FAILURE_KINDS.indexOf("unknown-exited");

/** The kind number of `browser-exited`, after which the window is closed instead of reloaded. */
export const BROWSER_EXITED_PROCESS_FAILED_KIND =
  PROCESS_FAILURE_KINDS.indexOf("browser-exited");

/**
 * WebView2 repeats the unresponsive report every few seconds while the renderer ignores input and
 * sends nothing when it recovers. A pause in the reports longer than this ends the freeze.
 */
const UNRESPONSIVE_EPISODE_GAP_MS = 60_000;

/**
 * Tells one freeze from the next so the repeated WebView2 reports of a single freeze reach the
 * backend once and do not fill the retained failure history that real failures need.
 */
export class UnresponsiveEpisode {
  private lastReportMs: number | undefined;

  /** Forget the current freeze, as after a new document finished loading, so the next report starts a new one. */
  reset(): void {
    this.lastReportMs = undefined;
  }

  /** Whether a report at `nowMs` (a monotonic clock reading) starts a new freeze; every report extends the current one. */
  begins(nowMs: number): boolean {
    const isNew =
      this.lastReportMs === undefined ||
      nowMs - this.lastReportMs > UNRESPONSIVE_EPISODE_GAP_MS;
    this.lastReportMs = nowMs;
    return isNew;
  }
}

/** What the host does about one `ProcessFailed` notification. */
export type ProcessFailurePlan = {
  /** Whether the failure is written to the host log. */
  log: boolean;
  /** The recovery reported to the backend, or `undefined` when nothing is reported. */
  report: WindowProcessFailureEvent["recovery"] | undefined;
  /** Whether the page session is revoked. */
  revokeSession: boolean;
  /** `close-window` for an exited browser process, `reload` for an exited renderer. */
  action: "none" | "close-window" | "reload";
};

/**
 * Decides the host's reaction to a WebView2 process failure. A hung renderer is still alive and may
 * finish its work, so it keeps its page and session and is only reported, once per freeze (Electron
 * likewise leaves an `unresponsive` page running). Any other failure ends the page: the session is
 * revoked and the view is reloaded, or the window closed when the browser process exited. A view
 * that is already closing needs no report.
 */
export function planProcessFailure(
  kind: number,
  closing: boolean,
  episode: UnresponsiveEpisode,
  nowMs: number,
): ProcessFailurePlan {
  if (isUnresponsiveFailure(kind)) {
    const begins = episode.begins(nowMs);
    return {
      log: begins,
      report: begins && !closing ? "none" : undefined,
      revokeSession: false,
      action: "none",
    };
  }
  const browserExited = kind === BROWSER_EXITED_PROCESS_FAILED_KIND;
  const recovery = browserExited ? "close" : "reload";
  return {
    log: true,
    report: closing ? undefined : recovery,
    revokeSession: true,
    action: browserExited ? "close-window" : "reload",
  };
}

/** A hung renderer is still alive: the host reports it but leaves the page running. */
export function isUnresponsiveFailure(kind: number): boolean {
  return processFailureKind(kind) === "renderer-unresponsive";
}

/** Name the WebView2 process failure kind reported by `ProcessFailed`. */
export function processFailureKind(kind: number): WindowProcessFailureKind {
  return PROCESS_FAILURE_KINDS[kind] ?? "unknown-exited";
}
