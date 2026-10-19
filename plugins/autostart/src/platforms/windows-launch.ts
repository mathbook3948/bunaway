import { win32 } from "node:path";
import { toUSVString } from "node:util";
import {
  AUTOSTART_ARGUMENT,
  AUTOSTART_HIDDEN_ARGUMENT,
} from "@bunaway/protocol";
import type { AppLaunch } from "#autostart/contract";
import {
  invalid,
  registrationName,
  rejectDevelopmentHostOptions,
} from "#autostart/platforms/launch";
/** Run's documented command-line limit, measured in Windows UTF-16 code units. */
export const MAX_RUN_COMMAND_LENGTH = 260;

export { registrationName };

/** Reject NUL and broken UTF-16 before writing lossless Win32 strings. */
function validateText(value: string): void {
  if (value.includes("\0") || toUSVString(value) !== value) {
    invalid("Autostart arguments must be well-formed strings without NUL.");
  }
}

/** Quote one argument using Windows backslash-before-quote rules, including empty strings. */
function quoteArgument(value: string): string {
  validateText(value);
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

/** Build a bounded Run command from trusted host paths, never a caller-selected executable. */
export function commandLine(
  app: AppLaunch,
  args: readonly string[],
  hidden = false,
): string {
  const executable = app.launch.executablePath;
  validateText(executable);
  if (!win32.isAbsolute(executable) || /["\r\n]/.test(executable)) {
    invalid("Autostart requires an absolute Windows executable path.");
  }
  if (hidden && app.supportsHiddenStart !== true) {
    invalid("Hidden autostart requires desktop.tray in the app definition.");
  }
  rejectDevelopmentHostOptions(app, args);
  const result = [
    `"${executable}"`,
    ...app.launch.args.map(quoteArgument),
    quoteArgument(hidden ? AUTOSTART_HIDDEN_ARGUMENT : AUTOSTART_ARGUMENT),
    ...args.map(quoteArgument),
  ].join(" ");
  if (result.length > MAX_RUN_COMMAND_LENGTH) {
    invalid(
      "Autostart command exceeds the Windows Run limit of 260 UTF-16 code units.",
    );
  }
  return result;
}

/** Compare only the host restart prefix; user-specified application arguments may vary. */
export function matchesLaunch(
  app: AppLaunch,
  executable: string,
  args: readonly string[],
): boolean {
  return (
    win32.normalize(executable).toLowerCase() ===
      win32.normalize(app.launch.executablePath).toLowerCase() &&
    app.launch.args.every((arg, index) => args[index] === arg)
  );
}
