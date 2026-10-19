import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { BunawayError } from "@bunaway/protocol";

/** Longest the replacement waits for the previous host to disappear before it gives up. */
const PREDECESSOR_WAIT_SECONDS = 30;
/** Poll interval of the wait, in the unit `sleep` takes. */
const PREDECESSOR_POLL_SECONDS = 0.1;

/**
 * Waits until the process `$1` no longer exists, then replaces itself with the command after it. The
 * command arrives as separate arguments and is run with `exec "$@"`, never parsed by the shell, so
 * no argument can inject a command. It gives up (exit 1, nothing started) when the predecessor is
 * still there after `PREDECESSOR_WAIT_SECONDS`.
 */
const WAIT_THEN_EXEC = `previous=$1; shift; waited=0
while kill -0 "$previous" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -gt ${Math.round(PREDECESSOR_WAIT_SECONDS / PREDECESSOR_POLL_SECONDS)} ]; then exit 1; fi
  /bin/sleep ${PREDECESSOR_POLL_SECONDS}
done
exec "$@"`;

/** Facts about the running host that decide how the same app is started again. */
export type MacosHostLaunch = {
  /** Absolute path of the host executable (`launch.executablePath` of the app config). */
  executablePath: string;
  /** Arguments of the host executable, without app arguments (`launch.args`). */
  args: readonly string[];
  /** Working directory at boot, which the new process keeps. */
  cwd: string;
  /** Environment at boot, which the new process inherits. */
  env: NodeJS.ProcessEnv;
};

/** The process that starts the replacement once the previous host has exited. */
export type RelaunchCommand = {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

/**
 * Builds the command that starts this host again after process `previousPid` exited. The
 * executable, arguments, working directory and environment come from the running host; the app
 * cannot choose them.
 */
export function relaunchCommand(
  host: MacosHostLaunch,
  previousPid: number,
): RelaunchCommand {
  return {
    executable: "/bin/sh",
    args: [
      "-c",
      WAIT_THEN_EXEC,
      "bunaway-relaunch",
      String(previousPid),
      host.executablePath,
      ...host.args,
    ],
    cwd: host.cwd,
    env: host.env,
  };
}

/**
 * macOS apps receive no launch arguments (`OpenRequest.argv` is always empty; the OS delivers files
 * and URLs as open requests), so a non-empty `argv` could never reach the app. It is refused
 * before the app quits instead of being dropped.
 */
export function checkRelaunchArguments(
  argv: readonly string[] | undefined,
): void {
  if (argv !== undefined && argv.length > 0) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message:
        "relaunch argv must be empty on macOS: apps receive no launch arguments.",
    });
  }
}

/**
 * Starts the replacement in a new session, outside the host's process group, so neither the final
 * process group sweep nor the death guard (which signals only that group) can reach it. It is
 * detached from the host's streams and does not keep the host alive. Resolves once the process
 * exists; rejects when it cannot be created.
 */
export async function startRelaunch(
  command: RelaunchCommand,
): Promise<ChildProcess> {
  const child = spawn(
    command.executable,
    [
      ...command.args,
    ],
    {
      cwd: command.cwd,
      env: command.env,
      detached: true,
      stdio: "ignore",
    },
  );
  await once(child, "spawn");
  child.unref();
  return child;
}
