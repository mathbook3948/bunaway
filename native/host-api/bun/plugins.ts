import { isDeepStrictEqual } from "node:util";
import {
  BunawayError,
  type JsonValue,
  type NativeRegistration,
  NativeRegistry,
  type Policy,
  validateValue,
} from "@bunaway/protocol";
import type {
  NativeAdapter,
  NativeEnvironment,
  PackagedPlugin,
} from "./plugin-contract.ts";

/** Normalize a plugin contract through the protocol's JSON-value validator for comparison. */
const contractJson = (value: unknown) =>
  JSON.parse(JSON.stringify(validateValue({}, value)));

/** The validated dispatcher owned by one host execution thread. */
type PluginOperations = {
  execute(operation: string, input: unknown, source: string): JsonValue;
  executeUI(
    operation: string,
    input: unknown,
    source: string,
    context: {
      requestId: string;
      permissions: Policy["backend"];
      signal?: AbortSignal;
    },
  ): Promise<JsonValue>;
  busy(): boolean;
  dispose(): Promise<void>;
};

/** Build the registry and reject registrations that differ from their installed package. */
export function pluginRegistry(
  plugins: readonly NativeRegistration[],
  catalog: readonly PackagedPlugin[],
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
  windows: NativeEnvironment["windows"] | undefined,
  catalog: readonly PackagedPlugin[],
  app?: NativeEnvironment["app"],
): Promise<PluginOperations> {
  const registry = pluginRegistry(plugins, catalog);
  // Capability discovery and dispatch use the same installed platform support contract.
  const supported = new Set(
    [
      ...registry.operations.keys(),
    ].filter((operation) => {
      const plugin = catalog.find((entry) =>
        operation.startsWith(`${entry.name}.`),
      );
      return (
        plugin?.execution !== undefined &&
        (plugin.supportedOperations === undefined ||
          plugin.supportedOperations.includes(operation))
      );
    }),
  );
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
    ...(app
      ? {
          app,
        }
      : {}),
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
        support: supported.has(operation.name)
          ? ("supported" as const)
          : ("unsupported" as const),
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
      if (!adapter || !supported.has(operation)) {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "Plugin operation is not supported on this platform.",
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
        signal?: AbortSignal;
      },
    ) {
      const call = registry.validateCall({
        operation,
        payload: input as never,
      });
      const adapter = adapters.get(operation.split(".")[0] ?? "");
      if (!adapter || !supported.has(operation)) {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "Plugin operation is not supported on this platform.",
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
