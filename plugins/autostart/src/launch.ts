import { win32 } from "node:path";
import { toUSVString } from "node:util";
import type { NativeEnvironment } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";

/** Run's documented command-line limit, measured in Windows UTF-16 code units. */
export const MAX_RUN_COMMAND_LENGTH = 260;
export type AppLaunch = NonNullable<NativeEnvironment["app"]>;

function invalid(message: string): never {
  throw new BunawayError({
    code: "INVALID_ARGUMENT",
    message,
  });
}

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

/** The identity includes the launch mode so development cannot overwrite the installed app. */
export function registrationName(app: AppLaunch): string {
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(app.id)) {
    invalid("Invalid autostart app identifier.");
  }
  // A mode prefix, rather than a suffix, also separates IDs ending in .development.
  return `bunaway.${app.launch.mode}.${app.id}`;
}

/** Build a bounded Run command from trusted host paths, never a caller-selected executable. */
export function commandLine(app: AppLaunch, args: readonly string[]): string {
  const executable = app.launch.executablePath;
  validateText(executable);
  if (!win32.isAbsolute(executable) || /["\r\n]/.test(executable)) {
    invalid("Autostart requires an absolute Windows executable path.");
  }
  if (
    app.launch.mode === "development" &&
    [
      "--devtools",
      "--dev-url",
    ].includes(args[0] ?? "")
  ) {
    invalid("Autostart cannot persist development host options.");
  }
  const result = [
    `"${executable}"`,
    ...app.launch.args.map(quoteArgument),
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
