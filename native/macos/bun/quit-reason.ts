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
 * Classifies a request that reached `applicationShouldTerminate:`.
 *
 * @param quitReasonCode The `keyAEQuitReason` value of the quit Apple event being handled, or
 * `undefined` when none is being handled (`NSApp terminate:`, Cmd+Q and the Dock's Quit send none).
 */
export function classifyQuit(
  quitReasonCode: number | undefined,
): "session-end" | "quit-command" {
  return quitReasonCode !== undefined &&
    SESSION_END_QUIT_REASONS.has(quitReasonCode)
    ? "session-end"
    : "quit-command";
}
