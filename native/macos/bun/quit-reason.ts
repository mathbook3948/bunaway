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
 * Quit reasons (`kAEReallyLogOut`, `kAERestart`, `kAEShutDown`) that mean the user session is
 * ending. Any other reason, or none, is an ordinary Quit command.
 */
const SESSION_END_QUIT_REASONS: ReadonlySet<number> = new Set([
  fourCharCode("rlgo"),
  fourCharCode("rest"),
  fourCharCode("shut"),
]);

/**
 * Classifies a quit Apple event handled by the host's own handler (`kCoreEventClass` and
 * `kAEQuitApplication`). Quit commands that go through `terminate:` (the Quit menu and Cmd+Q)
 * carry no Apple event and never reach this function.
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
