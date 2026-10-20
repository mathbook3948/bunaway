import type { NativeEnvironment } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import { MAX_SHORTCUT_ARGUMENTS_LENGTH } from "#opener/contract";
import { quoteShellTarget } from "#opener/platforms/windows-shell";

type AppLaunch = NonNullable<NativeEnvironment["app"]>["launch"];

/**
 * The argument line of a Jump List entry: the app's own launch arguments, so a development
 * run starts the same script, followed by the entry's arguments. Each is quoted with the
 * Windows argv rules. A `%` or control character in the launch arguments cannot be encoded
 * safely, so the entry is refused as UNSUPPORTED for this launch command.
 */
export function buildJumpListArguments(
  launch: AppLaunch,
  args: readonly string[],
): string {
  if (launch.args.some((part) => /[\p{Cc}%]/u.test(part))) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message:
        "The app launch command contains characters that cannot be used in a Jump List entry.",
    });
  }
  const line = [
    ...launch.args,
    ...args,
  ]
    .map(quoteShellTarget)
    .join(" ");
  if (line.length > MAX_SHORTCUT_ARGUMENTS_LENGTH) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "The Jump List entry arguments are too long.",
    });
  }
  return line;
}

/**
 * Read the run of backslashes at `index`. In front of a quote, each pair stands for one
 * backslash and an odd one out makes the quote literal, which this run then also consumes;
 * anywhere else the backslashes are literal.
 */
function readBackslashes(
  line: string,
  index: number,
): {
  text: string;
  next: number;
} {
  let next = index;
  while (line.charAt(next) === "\\") {
    next++;
  }
  const count = next - index;
  if (line.charAt(next) !== '"') {
    return {
      text: "\\".repeat(count),
      next,
    };
  }
  const literalQuote = count % 2 === 1;
  return {
    text: "\\".repeat(Math.floor(count / 2)) + (literalQuote ? '"' : ""),
    next: literalQuote ? next + 1 : next,
  };
}

/**
 * Split an argument line by the rules of `CommandLineToArgvW` for arguments after the program
 * name: spaces and tabs separate arguments outside quotes, backslashes double only in front of
 * a quote, and a doubled quote inside quotes is a literal quote.
 */
export function parseArgumentLine(line: string): string[] {
  const args: string[] = [];
  let current = "";
  let started = false;
  let quoted = false;
  let index = 0;
  while (index < line.length) {
    const char = line.charAt(index);
    if (char === "\\") {
      const run = readBackslashes(line, index);
      current += run.text;
      index = run.next;
      started = true;
      continue;
    }
    index++;
    if (char === '"') {
      started = true;
      if (quoted && line.charAt(index) === '"') {
        current += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && (char === " " || char === "\t")) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }
  if (started) {
    args.push(current);
  }
  return args;
}

/**
 * The entry-specific arguments of a stored argument line, or null when the line does not
 * start with this app's launch arguments (an entry written by another build or run mode).
 */
export function entryArguments(
  launch: AppLaunch,
  line: string,
): string[] | null {
  const parsed = parseArgumentLine(line);
  const prefix = launch.args;
  if (
    parsed.length < prefix.length ||
    prefix.some((part, position) => parsed[position] !== part)
  ) {
    return null;
  }
  return parsed.slice(prefix.length);
}
