import { BunawayError } from "@bunaway/protocol";
import type { RelaunchCommand } from "./job.ts";

/** Marks a host started by `relaunch()`, so it waits for its predecessor to release the app lock. */
export const RELAUNCH_ENVIRONMENT = "BUNAWAY_RELAUNCH";

/** Facts about the running host that decide how the same host is started again. */
export type HostLaunch = {
  /** True for a packaged executable, which takes only the app arguments. */
  compiled: boolean;
  execPath: string;
  /** Bun options of a development host, such as `--inspect`, placed before the script. */
  execArgv: readonly string[];
  /** Development host script (`process.argv[1]`); unused when compiled. */
  script: string | undefined;
  /** Development switches (`--devtools`, `--dev-url <url>`) that precede app arguments. */
  switches: readonly string[];
  /** Working directory at boot, which the new host keeps. */
  cwd: string;
  env: NodeJS.ProcessEnv;
};

/**
 * Builds the command that starts this host again with new app arguments. The executable, working
 * directory and environment come from the running host and cannot be chosen by the app; the only
 * addition is the relaunch marker.
 */
export function relaunchCommand(
  host: HostLaunch,
  argv: readonly string[],
): RelaunchCommand {
  if (!host.compiled && host.script === undefined) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "Cannot relaunch: the host script is unknown.",
    });
  }
  return {
    executable: host.execPath,
    args: host.compiled
      ? argv
      : [
          ...host.execArgv,
          host.script as string,
          ...host.switches,
          ...argv,
        ],
    cwd: host.cwd,
    env: {
      ...host.env,
      [RELAUNCH_ENVIRONMENT]: "1",
    },
  };
}
