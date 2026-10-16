import type { SessionEndFlags } from "./channel.ts";

// Session-ending window messages are broadcast to every top-level window of the process.
const WM_QUERYENDSESSION = 0x0011;
const WM_ENDSESSION = 0x0016;
// WM_QUERYENDSESSION and WM_ENDSESSION lParam flags.
const ENDSESSION_CLOSEAPP = 0x1n;
const ENDSESSION_CRITICAL = 0x40000000n;
const ENDSESSION_LOGOFF = 0x80000000n;
/** lParam carries 32 bits of flags; the upper half of the 64-bit value is not defined. */
const LPARAM_FLAG_BITS = 32;

/**
 * Longest time the UI thread blocks inside WM_ENDSESSION for app cleanup. Windows may end the
 * process once the window procedure returns and gives an app roughly five seconds in total.
 */
export const SESSION_END_WAIT_MS = 4000;

/** Index of the single Int32 flag in the release buffer: 0 while waiting, 1 once released. */
const RELEASE_FLAG_INDEX = 0;
/** Size of the buffer shared between the UI thread (waits) and the main thread (releases). */
export const SESSION_END_RELEASE_BYTES = Int32Array.BYTES_PER_ELEMENT;

/** Decodes the lParam flags of WM_QUERYENDSESSION and WM_ENDSESSION. */
export function decodeSessionEndFlags(lparam: bigint): SessionEndFlags {
  const flags = BigInt.asUintN(LPARAM_FLAG_BITS, lparam);
  return {
    logoff: (flags & ENDSESSION_LOGOFF) !== 0n,
    critical: (flags & ENDSESSION_CRITICAL) !== 0n,
    closeApp: (flags & ENDSESSION_CLOSEAPP) !== 0n,
  };
}

/**
 * Main thread side of the UI wait: marks the release buffer done and wakes the UI thread.
 * Safe to call repeatedly.
 */
export function releaseSessionEndWait(release: SharedArrayBuffer): void {
  const flag = new Int32Array(release);
  Atomics.store(flag, RELEASE_FLAG_INDEX, 1);
  Atomics.notify(flag, RELEASE_FLAG_INDEX);
}

export type SessionMessageHooks = {
  /**
   * Called once, from the first confirmed session end. It must stop UI-side close and quit
   * requests and deliver `flags` and `release` to the main thread, which calls
   * `releaseSessionEndWait(release)` when app cleanup is complete.
   */
  begin(flags: SessionEndFlags, release: SharedArrayBuffer): void;
  /** Records a diagnostic event; fields are plain JSON values. */
  report(event: string, fields: Record<string, unknown>): void;
  /** Wait limit in milliseconds; a parameter so tests need no real wait. */
  waitMs?: number;
};

/** Returns a result for the window procedure, or undefined when the message is not a session message. */
export type SessionMessageHandler = (
  message: number,
  wparam: bigint,
  lparam: bigint,
) => bigint | undefined;

/**
 * Creates the one handler every top-level HWND of the UI thread routes session messages to.
 *
 * Session end is a non-cancellable shutdown. WM_QUERYENDSESSION always answers TRUE without
 * dialogs or app callbacks, because `beforeQuit` is asynchronous and cannot answer inside the
 * synchronous message. A confirmed WM_ENDSESSION (wParam TRUE) starts shutdown once across all
 * windows and repeated messages, then blocks the UI thread until the main thread reports that
 * app cleanup finished or `waitMs` elapses, because Windows may terminate the process as soon as
 * the window procedure returns.
 */
export function createSessionMessageHandler(
  hooks: SessionMessageHooks,
): SessionMessageHandler {
  const waitMs = hooks.waitMs ?? SESSION_END_WAIT_MS;
  let ended = false;
  return (message, wparam, lparam) => {
    if (message === WM_QUERYENDSESSION) {
      hooks.report("session-query-end", {
        ...decodeSessionEndFlags(lparam),
      });
      return 1n;
    }
    if (message !== WM_ENDSESSION) {
      return undefined;
    }
    const flags = decodeSessionEndFlags(lparam);
    if (wparam === 0n) {
      // The session end was cancelled, for example by another application; keep running.
      hooks.report("session-end-cancelled", {
        ...flags,
      });
      return 0n;
    }
    if (ended) {
      return 0n;
    }
    ended = true;
    const release = new SharedArrayBuffer(SESSION_END_RELEASE_BYTES);
    hooks.begin(flags, release);
    const started = performance.now();
    // Blocking is deliberate: it keeps the process alive while the main thread runs app cleanup.
    const outcome = Atomics.wait(
      new Int32Array(release),
      RELEASE_FLAG_INDEX,
      0,
      waitMs,
    );
    hooks.report("session-end-wait-finished", {
      timedOut: outcome === "timed-out",
      elapsedMs: Math.round(performance.now() - started),
    });
    return 0n;
  };
}
