import { win32 } from "node:path";
import type { NativeEnvironment } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import type { AutostartStatus, enableSchema } from "#autostart/contract";
import {
  commandLine,
  matchesLaunch,
  registrationName,
} from "#autostart/platforms/windows-launch";
import {
  APPROVAL_KEY,
  createRegistry,
  RUN_KEY,
  registryCommand,
  startupState,
} from "#autostart/platforms/windows-registry";
import {
  disablePackaged,
  enablePackaged,
  getPackagedStatus,
  openStartupTask,
} from "#autostart/platforms/windows-startup-task";

type EnableInput = z.output<typeof enableSchema>;

/** Own one user's app-scoped Run value, or the manifest StartupTask of an MSIX package, on the host I/O worker. */
export function initialize(environment: NativeEnvironment) {
  const app = environment.app;
  if (!app) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "Autostart requires a host-selected app launch.",
    });
  }
  return {
    app,
    name: registrationName(app),
    registry: createRegistry(),
    startupTask: openStartupTask,
    /** True while a StartupTask change waits on Windows. */
    changing: false,
  };
}

/**
 * The StartupTask path yields while Windows works, unlike the synchronous Run path. Overlapping
 * changes are rejected instead of interleaved, so one request cannot raise a second consent
 * prompt or race a disable.
 */
async function exclusive<T>(
  state: ReturnType<typeof initialize>,
  change: () => Promise<T>,
): Promise<T> {
  if (state.changing) {
    throw new BunawayError({
      code: "BUSY",
      message: "Another autostart change is in progress.",
    });
  }
  state.changing = true;
  try {
    return await change();
  } finally {
    state.changing = false;
  }
}

/** Read the registration and the user's separate startup approval state. */
export function getStatus(
  state: ReturnType<typeof initialize>,
  signal?: AbortSignal,
): AutostartStatus | Promise<AutostartStatus> {
  if (state.registry.packaged()) {
    return getPackagedStatus(state.startupTask, signal);
  }
  return getRunStatus(state);
}

function getRunStatus(state: ReturnType<typeof initialize>): AutostartStatus {
  const value = state.registry.read(RUN_KEY, state.name);
  const command = registryCommand(value);
  const parsed = command ? state.registry.parse(command) : [];
  const executable = parsed[0];
  // Unquoted paths with spaces can select a different executable in CreateProcessW.
  const valid =
    !!command?.startsWith('"') &&
    !!executable &&
    win32.isAbsolute(executable) &&
    !/["\r\n]/.test(executable);
  const args = valid ? parsed.slice(1) : null;
  return {
    registrationName: state.name,
    registered: value !== null,
    commandLine: command,
    executablePath: valid ? executable : null,
    args,
    startupState: startupState(state.registry.read(APPROVAL_KEY, state.name)),
    matchesCurrentLaunch:
      valid && args !== null && matchesLaunch(state.app, executable, args),
  };
}

export function enable(
  state: ReturnType<typeof initialize>,
  input: EnableInput,
  signal?: AbortSignal,
): AutostartStatus | Promise<AutostartStatus> {
  if (state.registry.packaged()) {
    return exclusive(state, () =>
      enablePackaged(state.startupTask, input, signal),
    );
  }
  const command = commandLine(state.app, input.args, input.hidden);
  return state.registry.withRunLock(state.name, () => {
    // Repeating the request must not rewrite Run during a login launch.
    if (registryCommand(state.registry.read(RUN_KEY, state.name)) !== command) {
      state.registry.write(state.name, command);
    }
    return getRunStatus(state);
  });
}

export function disable(
  state: ReturnType<typeof initialize>,
  signal?: AbortSignal,
): null | Promise<null> {
  if (state.registry.packaged()) {
    return exclusive(state, () => disablePackaged(state.startupTask, signal));
  }
  state.registry.remove(state.name);
  return null;
}

export function dispose(state: ReturnType<typeof initialize>) {
  state.registry.dispose();
}
