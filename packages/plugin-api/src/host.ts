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
// Reusing wrappers keeps repeated app composition idempotent and preserves registry identity.
const commands = new WeakMap<CommandDefinition, CommandDefinition>();
const plugins = new WeakMap<PluginDefinition, PluginDefinition>();

// Command scopes end with their work; setup descendants keep the backend scope
// so plugin timers can use it until shutdown aborts the shared signal.
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

/**
 * Returns the active command or plugin setup Host API. Throws `INVALID_ARGUMENT`
 * outside a scope and `CANCELLED` after that scope ends or its signal aborts.
 */
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

/**
 * Wraps command execution in its invocation context so `host` resolves to the
 * correct caller across asynchronous work. Rebinding the same object reuses its
 * wrapper and leaves the original definition untouched.
 */
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

/**
 * Binds plugin commands and setup descendants to the plugin's backend context.
 * The returned stop hook runs in that context for cleanup, after Core has
 * aborted its signal. Rebinding the same plugin object reuses its wrapper.
 */
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
