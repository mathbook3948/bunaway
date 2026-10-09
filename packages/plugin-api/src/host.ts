import { AsyncLocalStorage } from "node:async_hooks";
import { BunawayError, type HostAPI } from "@bunaway/protocol";
import type {
  CommandContext,
  CommandDefinition,
  PluginDefinition,
} from "./index.ts";

type HostScope = {
  context: CommandContext;
  active: boolean;
};
const scopes = new AsyncLocalStorage<HostScope>();
const commands = new WeakMap<CommandDefinition, CommandDefinition>();
const plugins = new WeakMap<PluginDefinition, PluginDefinition>();

// Each asynchronous command keeps its own caller's Host API. Setup descendants
// retain the backend lifetime, including timers created by a plugin's setup.
async function runWithHost<T>(
  context: CommandContext,
  run: () => T | Promise<T>,
  keepBackendContextAlive = false,
): Promise<T> {
  const scope: HostScope = {
    context,
    active: true,
  };
  return scopes.run(scope, async () => {
    try {
      return await run();
    } finally {
      if (!keepBackendContextAlive) {
        scope.active = false;
      }
    }
  });
}

export function currentHost(): HostAPI {
  const scope = scopes.getStore();
  if (!scope) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message:
        "Host API requires a command or a plugin setup execution context.",
    });
  }
  if (!scope.active || scope.context.signal.aborted) {
    throw new BunawayError({
      code: "CANCELLED",
      message: "Host execution context ended.",
    });
  }
  return scope.context.host;
}

export function bindCommandHost<T extends CommandDefinition>(definition: T): T {
  const existing = commands.get(definition);
  if (existing) {
    return existing as T;
  }
  // Preserve schema getters when the definition is copied onto the wrapper.
  const bound = {
    ...definition,
    input: definition.input,
    output: definition.output,
    run(payload: unknown, context: CommandContext) {
      return runWithHost(context, () => definition.run(payload, context));
    },
  };
  commands.set(definition, bound);
  commands.set(bound, bound);
  return bound;
}

export function bindPluginHost(plugin: PluginDefinition): PluginDefinition {
  const existing = plugins.get(plugin);
  if (existing) {
    return existing;
  }
  const {
    name,
    version,
    dependencies,
    platforms,
    native,
    requiredPermissions,
    commands: pluginCommands,
    events,
    setup,
  } = plugin;
  const boundCommands = pluginCommands
    ? Object.fromEntries(
        Object.entries(pluginCommands).map(([name, definition]) => [
          name,
          bindCommandHost(definition),
        ]),
      )
    : undefined;
  if (!boundCommands && !setup) {
    return plugin;
  }
  // Materialize contract properties because plugin definitions may expose them as getters.
  const bound: PluginDefinition = {
    ...plugin,
    name,
    version,
    ...(dependencies === undefined
      ? {}
      : {
          dependencies,
        }),
    ...(platforms === undefined
      ? {}
      : {
          platforms,
        }),
    ...(requiredPermissions === undefined
      ? {}
      : {
          requiredPermissions,
        }),
    ...(native === undefined
      ? {}
      : {
          native,
        }),
    ...(events === undefined
      ? {}
      : {
          events,
        }),
    ...(boundCommands
      ? {
          commands: Object.freeze(boundCommands),
        }
      : {}),
    ...(setup
      ? {
          async setup(context: CommandContext) {
            const stop = await runWithHost(
              context,
              () => setup.call(plugin, context),
              true,
            );
            if (typeof stop === "function") {
              return () => runWithHost(context, stop, true);
            }
          },
        }
      : {}),
  };
  plugins.set(plugin, bound);
  plugins.set(bound, bound);
  return bound;
}
