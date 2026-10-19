import { randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import {
  attemptAll,
  BunawayError,
  type NativeEnvironment,
} from "@bunaway/plugin";
import type { z } from "zod";
import type {
  AppLaunch,
  AutostartStatus,
  enableSchema,
} from "#autostart/contract";
import { registrationName } from "#autostart/platforms/launch";
import {
  buildLaunchAgent,
  displayCommand,
  type LaunchAgent,
  MAX_PLIST_BYTES,
  matchesLaunch,
  parseLaunchAgent,
  programArguments,
} from "#autostart/platforms/macos-launch-agent";

type EnableInput = z.output<typeof enableSchema>;
/** Per-user LaunchAgents folder, relative to the home directory. */
const LAUNCH_AGENTS = join("Library", "LaunchAgents");
const DIRECTORY_MODE = 0o755;
const FILE_MODE = 0o644;
const DENIED_CODES = new Set([
  "EACCES",
  "EPERM",
  "EROFS",
]);

type Existing =
  | {
      kind: "absent";
    }
  | {
      kind: "foreign";
    }
  | {
      kind: "managed";
      agent: LaunchAgent;
      text: string;
    };

/** One user's launch agent for this app and launch mode. */
export type AutostartState = {
  app: AppLaunch;
  name: string;
  directory: string;
  file: string;
};

/** Resolve the plist location for `home`; the file name is only the validated registration name. */
export function createState(app: AppLaunch, home: string): AutostartState {
  if (!posix.isAbsolute(home)) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "Autostart requires an absolute home directory.",
    });
  }
  const name = registrationName(app);
  const directory = join(home, LAUNCH_AGENTS);
  return {
    app,
    name,
    directory,
    file: join(directory, `${name}.plist`),
  };
}

/** Bind the current user's home and the host-selected app launch. No file is touched. */
export function initialize(environment: NativeEnvironment): AutostartState {
  const app = environment.app;
  if (!app) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "Autostart requires a host-selected app launch.",
    });
  }
  return createState(app, homedir());
}

function failure(error: unknown, message: string): BunawayError {
  if (error instanceof BunawayError) {
    return error;
  }
  const code = Reflect.get(Object(error), "code");
  return new BunawayError({
    code: DENIED_CODES.has(code) ? "PERMISSION_DENIED" : "INTERNAL",
    message,
  });
}

/** Run file work, reporting operating system failures as plugin errors. */
function guard<T>(message: string, work: () => T): T {
  try {
    return work();
  } catch (error) {
    throw failure(error, message);
  }
}

function inspect(state: AutostartState): Existing {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(state.file);
  } catch (error) {
    if (Reflect.get(Object(error), "code") === "ENOENT") {
      return {
        kind: "absent",
      };
    }
    throw error;
  }
  // A link, directory or oversized file was not written by this adapter.
  if (!info.isFile() || info.size > MAX_PLIST_BYTES) {
    return {
      kind: "foreign",
    };
  }
  const text = readFileSync(state.file, "utf8");
  const agent = parseLaunchAgent(text);
  return agent?.label === state.name
    ? {
        kind: "managed",
        agent,
        text,
      }
    : {
        kind: "foreign",
      };
}

function foreignFailure(): BunawayError {
  return new BunawayError({
    code: "INTERNAL",
    message:
      "An existing launch agent with this name was not created by this app and was left unchanged.",
  });
}

function statusOf(state: AutostartState, existing: Existing): AutostartStatus {
  const base = {
    registrationName: state.name,
    registered: false,
    commandLine: null,
    executablePath: null,
    args: null,
    startupState: "unknown",
    matchesCurrentLaunch: false,
  } as const;
  if (existing.kind !== "managed") {
    return base;
  }
  const stored = existing.agent.programArguments;
  const valid =
    stored !== null &&
    stored.length > 0 &&
    posix.isAbsolute(stored[0] ?? "") &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point.
    !stored.some((value) => /[\u0000-\u001f\u007f]/.test(value));
  return {
    ...base,
    registered: existing.agent.runAtLoad,
    commandLine: stored ? displayCommand(stored) : null,
    executablePath: valid ? (stored[0] ?? null) : null,
    args: valid ? stored.slice(1) : null,
    matchesCurrentLaunch: valid && matchesLaunch(state.app, stored),
  };
}

/** Read the stored launch agent without repairing or loading it. */
export function getStatus(state: AutostartState): AutostartStatus {
  return guard("Reading the launch agent failed.", () =>
    statusOf(state, inspect(state)),
  );
}

/** Write `text` to a private temporary file, then rename it over the plist. */
function writeAtomically(state: AutostartState, text: string): void {
  mkdirSync(state.directory, {
    recursive: true,
    mode: DIRECTORY_MODE,
  });
  const temp = join(
    state.directory,
    `.${state.name}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const fd = openSync(temp, "wx", FILE_MODE);
  let open = true;
  try {
    // The mode passed to open is reduced by the umask; the plist must stay readable by launchd.
    fchmodSync(fd, FILE_MODE);
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    open = false;
    renameSync(temp, state.file);
  } catch (error) {
    try {
      attemptAll(
        [
          () => open && closeSync(fd),
          () => unlinkSync(temp),
        ],
        "Removing the temporary launch agent failed.",
      );
    } catch (cleanup) {
      throw new AggregateError(
        [
          error,
          cleanup,
        ],
        "Writing the launch agent failed.",
      );
    }
    throw error;
  }
}

/** Register this app's launch agent. It takes effect at the next login, not in this session. */
export function enable(
  state: AutostartState,
  input: EnableInput,
): AutostartStatus {
  const text = buildLaunchAgent(
    state.name,
    programArguments(state.app, input.args, input.hidden),
  );
  return guard("Writing the launch agent failed.", () => {
    const existing = inspect(state);
    if (existing.kind === "foreign") {
      throw foreignFailure();
    }
    // Repeating the request must not rewrite the plist.
    if (existing.kind !== "managed" || existing.text !== text) {
      writeAtomically(state, text);
    }
    return statusOf(state, inspect(state));
  });
}

/** Remove only this app's launch agent; a missing file succeeds. */
export function disable(state: AutostartState): null {
  return guard("Removing the launch agent failed.", () => {
    if (inspect(state).kind === "foreign") {
      throw foreignFailure();
    }
    rmSync(state.file, {
      force: true,
    });
    return null;
  });
}
