import assert from "node:assert/strict";
import type { CoreServices } from "@bunaway/core";
import {
  bindHostAPI as bind,
  type CoreFactory,
  createCore as create,
} from "@bunaway/core";
import { capabilitiesPlugin } from "@bunaway/plugin-capabilities";
import { logPlugin } from "@bunaway/plugin-log";
import { storagePlugin } from "@bunaway/plugin-storage";
import { windowsPlugin } from "@bunaway/plugin-windows";
import {
  type HostCall,
  type JsonValue,
  NativeRegistry,
  type Policy,
} from "@bunaway/protocol";
import { capabilitiesOperations } from "../../plugins/capabilities/src/contract.ts";
import { logOperations } from "../../plugins/log/src/contract.ts";
import { storageOperations } from "../../plugins/storage/src/contract.ts";
import { windowDefinitions } from "../../plugins/windows/src/contract.ts";
import { pluginParsers } from "./plugin-parsers.ts";

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
const parsers = new Map([
  [
    "storage",
    pluginParsers("storage", storageOperations),
  ],
  [
    "log",
    pluginParsers("log", logOperations),
  ],
  [
    "capabilities",
    pluginParsers("capabilities", capabilitiesOperations),
  ],
  [
    "windows",
    pluginParsers("windows", windowDefinitions),
  ],
]);
function parser(operation: string) {
  return present(parsers.get(operation.split(".")[0] ?? ""));
}
/** Simulate the owning worker's SDK validation around a fixture adapter. */
function workerHost(
  callHost: CoreServices["callHost"],
): CoreServices["callHost"] {
  return async (context, call, signal) => {
    const response = await callHost(
      context,
      await validateHostInput(call),
      signal,
    );
    return response.kind === "result"
      ? {
          ...response,
          payload: await validateHostOutput(call.operation, response.payload),
        }
      : response;
  };
}
export async function validateHostInput(call: HostCall): Promise<HostCall> {
  return parser(call.operation).validateCall(registry.validateCall(call));
}
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
) => bind(args[0], args[1], workerHost(args[2]), registry);
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
    {
      ...services,
      callHost: workerHost(services.callHost),
    },
  );
/** Return whether a fixture host call passes the shared registry and policy. */
export async function allowedHost(
  permissions: Policy["backend"],
  call: HostCall,
) {
  try {
    return registry.allowed(permissions, await validateHostInput(call));
  } catch {
    return false;
  }
}
/** Validate host output and reject duplicate names in capability snapshots. */
export async function validateHostOutput(
  operation: string,
  value: unknown,
): Promise<JsonValue> {
  const output = await parser(operation).validateOutput(operation, value);
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
