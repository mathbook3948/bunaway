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

const matches = storagePlugin.matches;
function present<T>(value: T | undefined): T {
  assert(value !== undefined, "Missing native fixture contract.");
  return value;
}
export const plugins = [
  storagePlugin,
  logPlugin,
  capabilitiesPlugin,
];
export const registry = new NativeRegistry(plugins);
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
export const bindHostAPI = (
  ...args: Parameters<typeof bind> extends [
    ...infer P,
    NativeRegistry,
  ]
    ? P
    : never
) => bind(...args, registry);
// Existing lifecycle suites explicitly use the shared native-feature fixture.
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
export function allowedHost(permissions: Policy["backend"], call: HostCall) {
  try {
    return registry.allowed(permissions, registry.validateCall(call), matches);
  } catch {
    return false;
  }
}
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
