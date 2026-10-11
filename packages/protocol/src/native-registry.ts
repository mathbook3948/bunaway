import { BunawayError } from "./contracts.ts";
import type {
  HostCall,
  HostOperationContract,
  NativePluginContract,
} from "./host-api.ts";
import { policySchema } from "./schema.ts";
import {
  type Infer,
  type JsonValue,
  type Schema,
  validate,
} from "./validation.ts";

/** Installed plugin metadata and its optional native host contract. */
export type NativeRegistration = {
  readonly name: string;
  readonly version: string;
  readonly native?: NativePluginContract;
};
export type NativeRegistryOptions = {
  /** `runtime` enforces the aggregate active-plugin limits; `catalog` validates installed plugins. */
  readonly mode?: "runtime" | "catalog";
};
type HostPermissions = Infer<typeof policySchema>["backend"];

function fail(message: string): never {
  throw new BunawayError({
    code: "INVALID_ARGUMENT",
    message,
  });
}

/** Rejects malformed schemas and keywords this validator cannot enforce. */
function checkSchema(schema: Schema): void {
  const fields = new Set([
    "$schema",
    "type",
    "const",
    "enum",
    "anyOf",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
    "uniqueItems",
    "maxLength",
    "pattern",
  ]);
  if (
    !schema ||
    typeof schema !== "object" ||
    Array.isArray(schema) ||
    Object.keys(schema).some((key) => !fields.has(key))
  ) {
    fail("Invalid plugin schema.");
  }
  if (
    schema.type !== undefined &&
    ![
      "object",
      "array",
      "string",
      "integer",
      "boolean",
    ].includes(schema.type)
  ) {
    fail("Invalid plugin schema type.");
  }
  if (
    schema.const !== undefined &&
    schema.const !== null &&
    ![
      "string",
      "number",
      "boolean",
    ].includes(typeof schema.const)
  ) {
    fail("Invalid plugin schema constant.");
  }
  if (schema.$schema !== undefined && typeof schema.$schema !== "string") {
    fail("Invalid plugin schema identifier.");
  }
  if (
    schema.items !== undefined &&
    (!schema.items ||
      typeof schema.items !== "object" ||
      Array.isArray(schema.items))
  ) {
    fail("Invalid plugin item schema.");
  }
  if (
    schema.additionalProperties !== undefined &&
    schema.additionalProperties !== false
  ) {
    fail("Invalid plugin object schema.");
  }
  for (const list of [
    schema.enum,
    schema.required,
  ]) {
    if (
      list !== undefined &&
      (!Array.isArray(list) || list.some((value) => typeof value !== "string"))
    ) {
      fail("Invalid plugin schema list.");
    }
  }
  for (const count of [
    schema.minItems,
    schema.maxItems,
    schema.maxLength,
  ]) {
    if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) {
      fail("Invalid plugin schema limit.");
    }
  }
  for (const number of [
    schema.minimum,
    schema.maximum,
  ]) {
    if (number !== undefined && typeof number !== "number") {
      fail("Invalid plugin schema bound.");
    }
  }
  if (
    schema.uniqueItems !== undefined &&
    typeof schema.uniqueItems !== "boolean"
  ) {
    fail("Invalid plugin schema uniqueness.");
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") {
      fail("Invalid plugin schema pattern.");
    }
    try {
      new RegExp(schema.pattern, "u");
    } catch {
      fail("Invalid plugin schema pattern.");
    }
  }
  if (
    schema.properties !== undefined &&
    (!schema.properties ||
      typeof schema.properties !== "object" ||
      Array.isArray(schema.properties))
  ) {
    fail("Invalid plugin schema properties.");
  }
  if (
    schema.anyOf !== undefined &&
    (!Array.isArray(schema.anyOf) || !schema.anyOf.length)
  ) {
    fail("Invalid plugin schema alternatives.");
  }
  for (const child of [
    ...Object.values(schema.properties ?? {}),
    ...(schema.anyOf ?? []),
    ...(schema.items
      ? [
          schema.items,
        ]
      : []),
  ]) {
    checkSchema(child);
  }
}

/** Validates registered native contracts and evaluates their policy grants. */
export class NativeRegistry {
  readonly operations = new Map<string, HostOperationContract>();
  readonly plugins = new Set<string>();

  /** Validates plugin identities and native contracts, then snapshots their schemas. */
  constructor(
    plugins: readonly NativeRegistration[],
    options: NativeRegistryOptions = {},
  ) {
    const mode = options.mode ?? "runtime";
    if (mode !== "runtime" && mode !== "catalog") {
      fail("Invalid plugin registry mode.");
    }
    for (const plugin of plugins) {
      if (
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(plugin.name) ||
        this.plugins.has(plugin.name) ||
        typeof plugin.version !== "string" ||
        !plugin.version
      ) {
        fail("Invalid or duplicate plugin name.");
      }
      this.plugins.add(plugin.name);
      if (!plugin.native) {
        continue;
      }
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(plugin.name)) {
        fail("Invalid native plugin name.");
      }
      // Copy the contracts once: caller mutations cannot change registered validation.
      const native = validate(
        {
          type: "object",
          properties: {
            operations: {
              type: "array",
              maxItems: 256,
              items: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                  },
                  input: {
                    type: "object",
                  },
                  output: {
                    type: "object",
                  },
                },
                required: [
                  "name",
                  "input",
                  "output",
                ],
                additionalProperties: false,
              },
            },
          },
          required: [
            "operations",
          ],
          additionalProperties: false,
        },
        plugin.native,
      ) as unknown as NativePluginContract;
      for (const operation of native.operations) {
        if (
          !operation.name.startsWith(`${plugin.name}.`) ||
          !/^[A-Za-z0-9_.:-]{1,121}$/.test(operation.name) ||
          this.operations.has(operation.name)
        ) {
          fail("Invalid or duplicate plugin operation.");
        }
        this.operations.set(operation.name, operation);
        checkSchema(operation.input);
        checkSchema(operation.output);
      }
    }
    if (mode === "runtime" && this.operations.size > 256) {
      fail("Plugin contract limit reached.");
    }
  }

  /** Returns a registered operation or throws UNSUPPORTED when it is absent. */
  operation(name: string): HostOperationContract {
    const operation = this.operations.get(name);
    if (!operation) {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Host operation is not registered.",
      });
    }
    return operation;
  }

  /** Validates an operation input against the registered schema and returns a snapshot. */
  validateCall(call: HostCall): HostCall {
    return {
      operation: call.operation,
      payload: validate(this.operation(call.operation).input, call.payload),
    };
  }

  /** Validates and snapshots an operation result against its registered output schema. */
  validateOutput(name: string, output: unknown): JsonValue {
    return validate(this.operation(name).output, output);
  }

  /** Rejects policies that grant operations absent from the registered plugins. */
  validatePolicy(policy: Infer<typeof policySchema>): void {
    validate(policySchema, policy);
    for (const source of [
      policy.backend,
      ...policy.views.map((view) => view.host),
    ]) {
      for (const grant of source.permissions) {
        if (!this.operations.has(grant)) {
          fail("Policy references an unregistered operation.");
        }
      }
    }
  }

  /**
   * Checks whether the source explicitly grants this operation.
   * Throws UNSUPPORTED if the operation is not registered.
   */
  allowed(source: HostPermissions, call: HostCall): boolean {
    const operation = this.operation(call.operation);
    return source.permissions.includes(operation.name);
  }
}
