import { isDeepStrictEqual } from "node:util";
import { attemptAllAsync } from "@bunaway/plugin";
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
  NativePluginAdapter,
  PackagedPlugin,
} from "./plugin-contract.ts";

/** Normalize a plugin contract through the protocol's JSON-value validator for comparison. */
const contractJson = (value: unknown) =>
  JSON.parse(JSON.stringify(validateValue({}, value)));

/** The validated dispatcher owned by one host thread. */
type PluginOperations = {
  prepare(
    operation: string,
    input: unknown,
    source: string,
  ): Promise<() => Promise<JsonValue>>;
  prepareIO(
    operation: string,
    input: unknown,
    source: string,
    context: Parameters<NonNullable<NativeAdapter["executeUI"]>>[3],
  ): Promise<() => Promise<JsonValue>>;
  execute(
    operation: string,
    input: unknown,
    source: string,
  ): Promise<JsonValue>;
  executeUI(
    operation: string,
    input: unknown,
    source: string,
    context: {
      requestId: string;
      permissions: Policy["backend"];
      signal?: AbortSignal;
      beforeExecute?(): void;
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
export function disposeAll(
  actions: Iterable<() => void | Promise<void>>,
): Promise<void> {
  return attemptAllAsync(actions, "Native resource cleanup failed.");
}

/** Initialize only registered adapters for this worker and own their full cleanup lifecycle. */
export async function operations(
  plugins: readonly NativeRegistration[],
  dataRoot: string,
  thread: "worker" | "ui",
  windows: NativeEnvironment["windows"] | undefined,
  catalog: readonly PackagedPlugin[],
  app?: NativeEnvironment["app"],
  uiServices?: Pick<
    NativeEnvironment,
    "events" | "shortcuts" | "menus" | "tray" | "dialogs"
  >,
  /** Builds the `events` service of one plugin; the I/O Worker scopes each plugin to its own names. */
  eventsFor?: (pluginName: string) => NonNullable<NativeEnvironment["events"]>,
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
        plugin?.thread !== undefined &&
        (plugin.supportedOperations === undefined ||
          plugin.supportedOperations.includes(operation))
      );
    }),
  );
  const adapters = new Map<string, NativeAdapter | NativePluginAdapter>();
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
    ...uiServices,
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
        plugin.thread === thread &&
        plugin.operations &&
        plugins.some(
          (registered) => registered.name === plugin.name && registered.native,
        )
      ) {
        adapters.set(
          plugin.name,
          (await plugin.operations()).createOperations(
            eventsFor
              ? {
                  ...environment,
                  events: eventsFor(plugin.name),
                }
              : environment,
          ),
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
  /** Looks the operation up first so an unregistered name stays UNSUPPORTED whatever the payload is. */
  const validateCall = (operation: string, input: unknown) => {
    registry.operation(operation);
    return registry.validateCall({
      operation,
      payload: validateValue({}, input),
    });
  };
  const dispatcher: PluginOperations = {
    async prepare(operation: string, input: unknown, source: string) {
      const call = validateCall(operation, input);
      const adapter = adapters.get(operation.split(".")[0] ?? "");
      if (!adapter || !supported.has(operation)) {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "Plugin operation is not supported on this platform.",
        });
      }
      const execute =
        "prepare" in adapter
          ? await adapter.prepare(operation, call.payload, source)
          : () => adapter.execute(operation, call.payload, source);
      return async () => registry.validateOutput(operation, await execute());
    },
    async prepareIO(operation, input, source, context) {
      const adapter = adapters.get(operation.split(".")[0] ?? "");
      if (!adapter?.executeUI) {
        return dispatcher.prepare(operation, input, source);
      }
      const call = validateCall(operation, input);
      if (!supported.has(operation)) {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "Plugin operation is not supported on this platform.",
        });
      }
      if (!("prepare" in adapter)) {
        throw new Error("Contextual I/O requires an SDK-validated adapter.");
      }
      const execute = await adapter.prepare(
        operation,
        call.payload,
        source,
        context,
      );
      return async () => registry.validateOutput(operation, await execute());
    },
    async execute(operation, input, source) {
      const execute = await dispatcher.prepare(operation, input, source);
      return execute();
    },
    async executeUI(
      operation: string,
      input: unknown,
      source: string,
      context: {
        requestId: string;
        permissions: Policy["backend"];
        signal?: AbortSignal;
        beforeExecute?(): void;
      },
    ) {
      const call = validateCall(operation, input);
      const adapter = adapters.get(operation.split(".")[0] ?? "");
      if (!adapter || !supported.has(operation)) {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "Plugin operation is not supported on this platform.",
        });
      }
      const execute =
        "prepare" in adapter && !adapter.executeUI
          ? await adapter.prepare(operation, call.payload, source)
          : () => adapter.execute(operation, call.payload, source);
      context.signal?.throwIfAborted();
      context.beforeExecute?.();
      const output = adapter.executeUI
        ? await adapter.executeUI(operation, call.payload, source, context)
        : await execute();
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
  return dispatcher;
}
