/** Converts a four-character Apple event code such as `rlgo` to its big-endian 32-bit value. */
export function fourCharCode(text: string): number {
  if (!/^[\x20-\x7e]{4}$/.test(text)) {
    throw new Error(
      "A four-character code is four printable ASCII characters.",
    );
  }
  return Buffer.from(text, "latin1").readUInt32BE(0);
}

/** Attribute keyword of the quit Apple event that carries why the application is asked to quit (`keyAEQuitReason`). */
export const KEY_AE_QUIT_REASON = fourCharCode("why?");

/** Event class of the quit Apple event (`kCoreEventClass`). */
export const CORE_EVENT_CLASS = fourCharCode("aevt");

/** Event ID of the quit Apple event (`kAEQuitApplication`). */
export const QUIT_APPLICATION_EVENT_ID = fourCharCode("quit");

/**
 * Quit reasons (`kAELogOut`, `kAEReallyLogOut`, `kAERestart`, `kAEShutDown`) that mean the user
 * session is ending. loginwindow sends one of these as `keyAEQuitReason` when the session ends;
 * `kAELogOut` is the logout after the user confirmed the dialog. Any other reason, or none, is an
 * ordinary Quit command. `kAEShowRestartDialog` (`rrst`) and `kAEShowShutdownDialog` (`rsdn`) only
 * ask the app to show a confirmation dialog, so they do not end the session and are deliberately
 * absent here.
 */
const SESSION_END_QUIT_REASONS: ReadonlySet<number> = new Set([
  fourCharCode("logo"),
  fourCharCode("rlgo"),
  fourCharCode("rest"),
  fourCharCode("shut"),
]);

/** `typeType`: the descriptor holds a four-character type code, read with `typeCodeValue`. */
const DESCRIPTOR_TYPE_TYPE = fourCharCode("type");
/** `typeEnumerated`: the descriptor holds an enumeration code, read with `enumCodeValue`. */
const DESCRIPTOR_TYPE_ENUMERATED = fourCharCode("enum");

/**
 * Chooses the `NSAppleEventDescriptor` accessor that reads a `keyAEQuitReason` attribute, from the
 * descriptor's 32-bit `descriptorType`. Senders may encode the reason as a type or an enumeration
 * code; any other descriptor type carries no readable reason.
 */
export function quitReasonAccessor(
  descriptorType: number,
): "typeCodeValue" | "enumCodeValue" | undefined {
  if (descriptorType === DESCRIPTOR_TYPE_TYPE) {
    return "typeCodeValue";
  }
  if (descriptorType === DESCRIPTOR_TYPE_ENUMERATED) {
    return "enumCodeValue";
  }
  return undefined;
}

/** What the process-lifetime quit Apple event handler does with one event. */
export type QuitEventAction = "reply" | "session-end" | "request-quit";

/**
 * Routes a quit Apple event. The handler outlives the application object, so the decision covers
 * the state after `close()` too.
 *
 * @param state.applicationLive Whether a `MacosApplication` exists and is not closed. Without one
 * nobody can act on the event, so it is answered with success at once instead of being left
 * unhandled, which loginwindow could report as the app cancelling the logout.
 * @param state.sessionEndActive Whether a session end was already signalled (for example by the
 * power-off notification); every later quit event then belongs to it.
 * @param state.quitReasonCode The event's `keyAEQuitReason`, or `undefined` when it has none.
 * @param state.stopping Whether the host already began shutting down, so a new request is moot.
 * @returns `reply` to answer with success now, `session-end` to suspend the reply until app
 * cleanup, or `request-quit` to ask the app through `beforeQuit`.
 */
export function routeQuitEvent(state: {
  applicationLive: boolean;
  sessionEndActive: boolean;
  quitReasonCode: number | undefined;
  stopping: boolean;
}): QuitEventAction {
  if (!state.applicationLive) {
    return "reply";
  }
  if (
    state.sessionEndActive ||
    classifyQuit(state.quitReasonCode) === "session-end"
  ) {
    return "session-end";
  }
  return state.stopping ? "reply" : "request-quit";
}

/**
 * Classifies a quit Apple event handled by the host's own handler (`kCoreEventClass` and
 * `kAEQuitApplication`). Quit commands that go through `terminate:` (the Quit menu and Cmd+Q)
 * carry no Apple event and never reach this function. Logout (`logo`, `rlgo`), restart and shutdown
 * reasons are `session-end`; the confirmation-dialog reasons `rrst` and `rsdn` are `quit-command`.
 *
 * @param quitReasonCode The `keyAEQuitReason` value of the quit Apple event, or `undefined` when
 * the event has none (an `osascript` quit or the Dock's Quit).
 */
export function classifyQuit(
  quitReasonCode: number | undefined,
): "session-end" | "quit-command" {
  return quitReasonCode !== undefined &&
    SESSION_END_QUIT_REASONS.has(quitReasonCode)
    ? "session-end"
    : "quit-command";
}
