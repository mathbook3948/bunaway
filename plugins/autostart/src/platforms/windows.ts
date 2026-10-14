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

type EnableInput = z.output<typeof enableSchema>;

/** Own one user's app-scoped Run value on the host I/O worker. */
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
  };
}

/** Read both Run registration and the user's separate startup approval state. */
export function getStatus(
  state: ReturnType<typeof initialize>,
): AutostartStatus {
  state.registry.unpackaged();
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
) {
  state.registry.unpackaged();
  const command = commandLine(state.app, input.args, input.hidden);
  // Repeating the request must not rewrite Run during a login launch.
  if (registryCommand(state.registry.read(RUN_KEY, state.name)) !== command) {
    state.registry.write(state.name, command);
  }
  return getStatus(state);
}

export function disable(state: ReturnType<typeof initialize>): null {
  state.registry.unpackaged();
  state.registry.remove(state.name);
  return null;
}

export function dispose(state: ReturnType<typeof initialize>) {
  state.registry.dispose();
}
