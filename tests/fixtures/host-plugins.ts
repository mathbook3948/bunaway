import assert from "node:assert/strict";
import {
  bindHostAPI as bind,
  type CoreFactory,
  createCore as create,
} from "../../packages/core/src/index.ts";
import {
  type HostCall,
  type JsonValue,
  NativeRegistry,
  type Policy,
} from "../../packages/protocol/src/index.ts";
import { capabilitiesPlugin } from "../../plugins/capabilities/src/index.ts";
import { logPlugin } from "../../plugins/log/src/index.ts";
import { storagePlugin } from "../../plugins/storage/src/index.ts";
import { windowsPlugin } from "../../plugins/windows/src/index.ts";

const matches = storagePlugin.matches;
/** Fail fixture setup when an expected native operation is missing. */
function present<T>(value: T | undefined): T {
  assert(value !== undefined, "Missing native fixture contract.");
  return value;
}
export const plugins = [
  storagePlugin,
  logPlugin,
  capabilitiesPlugin,
  windowsPlugin,
];
export const registry = new NativeRegistry(plugins);
// Use contracts from the plugin declarations that build the shared registry.
export const contracts = {
  "storage.readText": present(
    storagePlugin.native.operations.find(
      (operation) => operation.name === "storage.readText",
    ),
  ),
  "storage.writeText": present(
    storagePlugin.native.operations.find(
      (operation) => operation.name === "storage.writeText",
    ),
  ),
  "log.write": present(
    logPlugin.native.operations.find(
      (operation) => operation.name === "log.write",
    ),
  ),
  "capabilities.get": present(
    capabilitiesPlugin.native.operations.find(
      (operation) => operation.name === "capabilities.get",
    ),
  ),
} as const;
export const hostOperations = contracts;
/** Bind a host API to the registry shared by the protocol and core fixtures. */
export const bindHostAPI = (
  ...args: Parameters<typeof bind> extends [
    ...infer P,
    NativeRegistry,
  ]
    ? P
    : never
) => bind(...args, registry);
/** Supply core fixtures with the shared native-feature plugins. */
export const createCore: CoreFactory = (app, services) =>
  create(
    {
      ...app,
      plugins: [
        ...plugins,
        ...(app.plugins ?? []),
      ],
    },
    services,
  );
/** Return whether a fixture host call passes the shared registry and policy. */
export function allowedHost(permissions: Policy["backend"], call: HostCall) {
  try {
    return registry.allowed(permissions, registry.validateCall(call), matches);
  } catch {
    return false;
  }
}
/** Validate host output and reject duplicate names in capability snapshots. */
export function validateHostOutput(
  operation: string,
  value: unknown,
): JsonValue {
  const output = registry.validateOutput(operation, value);
  if (operation === "capabilities.get") {
    const names = (
      output as {
        name: string;
      }[]
    ).map((feature) => feature.name);
    if (new Set(names).size !== names.length) {
      throw new Error("Duplicate capability name.");
    }
  }
  return output;
}
