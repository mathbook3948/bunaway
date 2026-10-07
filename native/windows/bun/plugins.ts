import { isDeepStrictEqual } from "node:util";
import {
  BunawayError,
  hostOperations,
  type NativeRegistration,
  NativeRegistry,
  type PermissionMatcher,
} from "../../../packages/protocol/src/index.ts";
import { type NativeAdapter, type NativeEnvironment, packagedPlugins } from "./plugin-table.ts";

export function pluginRegistry(plugins: readonly NativeRegistration[]) {
  const registry = new NativeRegistry(plugins);
  for (const plugin of plugins) {
    if (!plugin.native) continue;
    const packaged = packagedPlugins.find((entry) => entry.name === plugin.name);
    if (
      !packaged ||
      packaged.version !== plugin.version ||
      !isDeepStrictEqual(packaged.native, plugin.native)
    )
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Registered plugin does not match its installed package.",
      });
  }
  return registry;
}

export async function permissionMatcher(
  plugins: readonly NativeRegistration[],
): Promise<PermissionMatcher> {
  const matchers = new Map<string, PermissionMatcher>();
  for (const plugin of packagedPlugins) {
    if (
      plugin.authorization &&
      plugin.native.permissions.some((permission) => permission.scope) &&
      plugins.some((registered) => registered.name === plugin.name && registered.native)
    )
      matchers.set(plugin.name, (await plugin.authorization()).matches);
  }
  return (permission, input, scope) =>
    matchers.get(permission.split(":")[0] ?? "")?.(permission, input, scope) === true;
}

export async function disposeAll(actions: Iterable<() => void | Promise<void>>): Promise<void> {
  const errors: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Native resource cleanup failed.");
}

export async function operations(
  plugins: readonly NativeRegistration[],
  dataRoot: string,
  execution: "io" | "ui",
) {
  const registry = pluginRegistry(plugins);
  const adapters = new Map<string, NativeAdapter>();
  const dispose = () =>
    disposeAll([...adapters.values()].reverse().map((adapter) => () => adapter.dispose()));
  const environment: NativeEnvironment = {
    dataRoot,
    capabilities: [
      ...Object.keys(hostOperations).map((name) => ({
        name,
        support: "experimental" as const,
        permission: "not-required" as const,
      })),
      ...[...registry.operations.values()].map((operation) => ({
        name: operation.name,
        support: packagedPlugins.find((plugin) => operation.name.startsWith(`${plugin.name}.`))
          ?.execution
          ? ("supported" as const)
          : ("unsupported" as const),
        permission: operation.osPermission ?? ("unknown" as const),
      })),
    ],
  };
  try {
    for (const plugin of packagedPlugins) {
      if (
        plugin.execution === execution &&
        plugin.operations &&
        plugins.some((registered) => registered.name === plugin.name && registered.native)
      )
        adapters.set(plugin.name, (await plugin.operations()).createOperations(environment));
    }
  } catch (error) {
    try {
      await dispose();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Native plugin initialization failed.");
    }
    throw error;
  }
  return {
    execute(operation: string, input: unknown, source: string) {
      const call = registry.validateCall({ operation, payload: input as never });
      const adapter = adapters.get(operation.split(".")[0] ?? "");
      if (!adapter)
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "Plugin has no adapter for this platform.",
        });
      return registry.validateOutput(operation, adapter.execute(operation, call.payload, source));
    },
    dispose,
  };
}
