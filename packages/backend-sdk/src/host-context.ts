import { AsyncLocalStorage } from "node:async_hooks";
import type { CommandContext, CommandDefinition, PluginDefinition } from "@bunaway/core";
import { BunawayError, type HostAPI } from "@bunaway/protocol";

type HostScope = { context: CommandContext; active: boolean };
const scopes = new AsyncLocalStorage<HostScope>();
const commands = new WeakMap<CommandDefinition, CommandDefinition>();

// Each asynchronous command keeps its own caller's Host API. Setup descendants
// retain the backend lifetime, including timers created by a plugin's setup.
async function runWithHost<T>(
  context: CommandContext,
  run: () => T | Promise<T>,
  backend = false,
): Promise<T> {
  const scope: HostScope = { context, active: true };
  return scopes.run(scope, async () => {
    try {
      return await run();
    } finally {
      if (!backend) scope.active = false;
    }
  });
}

export function currentHost(): HostAPI {
  const scope = scopes.getStore();
  if (!scope)
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Host API requires a command or a plugin setup execution context.",
    });
  if (!scope.active || scope.context.signal.aborted)
    throw new BunawayError({ code: "CANCELLED", message: "Host execution context ended." });
  return scope.context.host;
}

export function bindCommandHost<T extends CommandDefinition>(definition: T): T {
  const existing = commands.get(definition);
  if (existing) return existing as T;
  const bound = {
    ...definition,
    run(payload: unknown, context: CommandContext) {
      return runWithHost(context, () => definition.run(payload, context));
    },
  };
  commands.set(definition, bound);
  commands.set(bound, bound);
  return bound;
}

export function bindPluginHost(plugin: PluginDefinition): PluginDefinition {
  const boundCommands = plugin.commands
    ? Object.fromEntries(
        Object.entries(plugin.commands).map(([name, definition]) => [
          name,
          bindCommandHost(definition),
        ]),
      )
    : undefined;
  const setup = plugin.setup;
  if (!boundCommands && !setup) return plugin;
  return {
    ...plugin,
    ...(boundCommands ? { commands: Object.freeze(boundCommands) } : {}),
    ...(setup
      ? {
          async setup(context: CommandContext) {
            const stop = await runWithHost(context, () => setup.call(plugin, context), true);
            if (typeof stop === "function") return () => runWithHost(context, stop, true);
          },
        }
      : {}),
  };
}
