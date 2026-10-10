import { win32 } from "node:path";
import type { NativeAdapter, NativeEnvironment } from "@bunaway/plugin";
import { BunawayError, NativeRegistry } from "@bunaway/protocol";
import { autostartPlugin, type AutostartStatus } from "./index.ts";
import { commandLine, matchesLaunch, registrationName } from "./launch.ts";
import {
  APPROVAL_KEY,
  createRegistry,
  registryCommand,
  RUN_KEY,
  startupState,
} from "./registry.ts";

/** Own one user's app-scoped Run value. I/O-worker authorization precedes every operation. */
export function createOperations(
  environment: NativeEnvironment,
): NativeAdapter {
  const app = environment.app;
  if (!app) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "Autostart requires a host-selected app launch.",
    });
  }
  const name = registrationName(app);
  const contracts = new NativeRegistry([
    autostartPlugin,
  ]);
  const registry = createRegistry();
  const getStatus = (): AutostartStatus => {
    const value = registry.read(RUN_KEY, name);
    const command = registryCommand(value);
    const parsed = command ? registry.parse(command) : [];
    const executable = parsed[0];
    // Unquoted paths with spaces can select a different executable in CreateProcessW.
    const valid =
      !!command?.startsWith('"') &&
      !!executable &&
      win32.isAbsolute(executable) &&
      !/["\r\n]/.test(executable);
    const args = valid ? parsed.slice(1) : null;
    return {
      registrationName: name,
      registered: value !== null,
      commandLine: command,
      executablePath: valid ? executable : null,
      args,
      startupState: startupState(registry.read(APPROVAL_KEY, name)),
      matchesCurrentLaunch:
        valid && args !== null && matchesLaunch(app, executable, args),
    };
  };
  return {
    execute(operation, input) {
      const call = contracts.validateCall({
        operation,
        payload: input,
      });
      registry.unpackaged();
      if (operation === "autostart.enable") {
        const payload = call.payload;
        // validateCall supplies the strict schema; keep narrowing concrete at this boundary.
        if (
          !payload ||
          typeof payload !== "object" ||
          Array.isArray(payload) ||
          !Array.isArray(payload.args) ||
          !payload.args.every((arg): arg is string => typeof arg === "string")
        ) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "Invalid autostart arguments.",
          });
        }
        const command = commandLine(app, payload.args);
        // Repeating the same request does not rewrite Run, especially during a login launch.
        if (registryCommand(registry.read(RUN_KEY, name)) !== command) {
          registry.write(name, command);
        }
        return getStatus();
      }
      if (operation === "autostart.disable") {
        registry.remove(name);
        return null;
      }
      return getStatus();
    },
    dispose: () => registry.dispose(),
  };
}
