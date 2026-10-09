import { isDeepStrictEqual } from "node:util";
import {
  BunawayError,
  type JsonValue,
  type NativeRegistration,
  NativeRegistry,
  type PermissionMatcher,
  type Policy,
  validateValue,
} from "../../../packages/protocol/src/index.ts";
import {
  type NativeAdapter,
  type NativeEnvironment,
  type PackagedPlugin,
  packagedPlugins,
} from "./plugin-table.ts";

/** Normalize a plugin contract through the protocol's JSON-value validator for comparison. */
const contractJson = (value: unknown) =>
  JSON.parse(JSON.stringify(validateValue({}, value)));

/** The validated dispatcher owned by one Windows worker. */
type PluginOperations = {
  execute(operation: string, input: unknown, source: string): JsonValue;
  executeUI(
    operation: string,
    input: unknown,
    source: string,
    context: {
      requestId: string;
      permissions: Policy["backend"];
    },
  ): Promise<JsonValue>;
  busy(): boolean;
  dispose(): Promise<void>;
};

/** Build the registry and reject registrations that differ from their installed package. */
export function pluginRegistry(
  plugins: readonly NativeRegistration[],
  catalog: readonly PackagedPlugin[] = packagedPlugins,
): NativeRegistry {
  const registry = new NativeRegistry(plugins);
  for (const plugin of plugins) {
    if (!plugin.native) {
      continue;
    }
    const packaged = catalog.find((entry) => entry.name === plugin.name);
    if (
      !packaged ||
      packaged.version !== plugin.version ||
      !isDeepStrictEqual(
        contractJson(packaged.native),
        contractJson(plugin.native),
      )
    ) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Registered plugin does not match its installed package.",
      });
    }
  }
  return registry;
}

/** Build a fail-closed scope matcher from installed, registered plugins. */
export async function permissionMatcher(
  plugins: readonly NativeRegistration[],
  catalog: readonly PackagedPlugin[] = packagedPlugins,
): Promise<PermissionMatcher> {
  const matchers = new Map<string, PermissionMatcher>();
  for (const plugin of catalog) {
    if (
      plugin.authorization &&
      plugin.native.permissions.some((permission) => permission.scope) &&
      plugins.some(
        (registered) => registered.name === plugin.name && registered.native,
      )
    ) {
      matchers.set(plugin.name, (await plugin.authorization()).matches);
    }
  }
  return (permission, input, scope) =>
    matchers.get(permission.split(":")[0] ?? "")?.(permission, input, scope) ===
    true;
}

/** Attempt every cleanup in order and report all failures together. */
export async function disposeAll(
  actions: Iterable<() => void | Promise<void>>,
): Promise<void> {
  const errors: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, "Native resource cleanup failed.");
  }
}

/** Initialize only registered adapters for this worker and own their full cleanup lifecycle. */
export async function operations(
  plugins: readonly NativeRegistration[],
  dataRoot: string,
  execution: "io" | "ui",
  windows?: NativeEnvironment["windows"],
  catalog: readonly PackagedPlugin[] = packagedPlugins,
): Promise<PluginOperations> {
  const registry = pluginRegistry(plugins, catalog);
  const adapters = new Map<string, NativeAdapter>();
  const dispose = () =>
    disposeAll(
      // Adapter resources may depend on earlier adapters, so release them in reverse creation order.
      [
        ...adapters.values(),
      ]
        .reverse()
        .map((adapter) => () => adapter.dispose()),
    );
  const environment: NativeEnvironment = {
    dataRoot,
    ...(windows
      ? {
          windows,
        }
      : {}),
    capabilities: [
      ...[
        ...registry.operations.values(),
      ].map((operation) => ({
        name: operation.name,
        support: catalog.find((plugin) =>
          operation.name.startsWith(`${plugin.name}.`),
        )?.execution
          ? ("supported" as const)
          : ("unsupported" as const),
        permission: operation.osPermission ?? ("unknown" as const),
      })),
    ],
  };
  try {
    // Do not import or initialize implementations for unregistered plugins or the other worker.
    for (const plugin of catalog) {
      if (
        plugin.execution === execution &&
        plugin.operations &&
        plugins.some(
          (registered) => registered.name === plugin.name && registered.native,
        )
      ) {
        adapters.set(
          plugin.name,
          (await plugin.operations()).createOperations(environment),
        );
      }
    }
  } catch (error) {
    try {
      // A partially initialized worker still owns every adapter created before the failure.
      await dispose();
    } catch (cleanup) {
      throw new AggregateError(
        [
          error,
          cleanup,
        ],
        "Native plugin initialization failed.",
      );
    }
    throw error;
  }
  return {
    execute(operation: string, input: unknown, source: string) {
      const call = registry.validateCall({
        operation,
        payload: input as never,
      });
      const adapter = adapters.get(operation.split(".")[0] ?? "");
      if (!adapter) {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "Plugin has no adapter for this platform.",
        });
      }
      return registry.validateOutput(
        operation,
        adapter.execute(operation, call.payload, source),
      );
    },
    async executeUI(
      operation: string,
      input: unknown,
      source: string,
      context: {
        requestId: string;
        permissions: Policy["backend"];
      },
    ) {
      const call = registry.validateCall({
        operation,
        payload: input as never,
      });
      const adapter = adapters.get(operation.split(".")[0] ?? "");
      if (!adapter) {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "Plugin has no adapter for this platform.",
        });
      }
      const output = adapter.executeUI
        ? await adapter.executeUI(operation, call.payload, source, context)
        : adapter.execute(operation, call.payload, source);
      return registry.validateOutput(operation, output);
    },
    busy() {
      for (const adapter of adapters.values()) {
        if (adapter.busy?.()) {
          return true;
        }
      }
      return false;
    },
    dispose,
  };
}
