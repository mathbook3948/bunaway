import { BunawayError } from "./contracts.ts";
import type {
  HostCall,
  HostOperationContract,
  NativePluginContract,
  PermissionContract,
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
/** Returns whether one permission's operation input matches a proposed scope. */
export type PermissionMatcher = (
  permission: string,
  input: JsonValue,
  scope: JsonValue,
) => boolean;
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
  readonly permissions = new Map<string, PermissionContract>();
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
                  permission: {
                    type: "string",
                  },
                  input: {
                    type: "object",
                  },
                  output: {
                    type: "object",
                  },
                  osPermission: {
                    const: "not-required",
                  },
                },
                required: [
                  "name",
                  "permission",
                  "input",
                  "output",
                ],
                additionalProperties: false,
              },
            },
            permissions: {
              type: "array",
              maxItems: 256,
              items: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                  },
                  scope: {
                    type: "object",
                  },
                },
                required: [
                  "name",
                ],
                additionalProperties: false,
              },
            },
          },
          required: [
            "operations",
            "permissions",
          ],
          additionalProperties: false,
        },
        plugin.native,
      ) as unknown as NativePluginContract;
      for (const permission of native.permissions) {
        if (
          !permission.name.startsWith(`${plugin.name}:`) ||
          !/^[A-Za-z0-9_.:-]{1,128}$/.test(permission.name) ||
          this.permissions.has(permission.name)
        ) {
          fail("Invalid or duplicate plugin permission.");
        }
        this.permissions.set(permission.name, permission);
        if (permission.scope) {
          checkSchema(permission.scope);
        }
      }
      for (const operation of native.operations) {
        if (
          !operation.name.startsWith(`${plugin.name}.`) ||
          !/^[A-Za-z0-9_.:-]{1,121}$/.test(operation.name) ||
          this.operations.has(operation.name) ||
          !native.permissions.some(
            (permission) => permission.name === operation.permission,
          )
        ) {
          fail("Invalid or duplicate plugin operation.");
        }
        this.operations.set(operation.name, operation);
        checkSchema(operation.input);
        checkSchema(operation.output);
      }
    }
    if (
      mode === "runtime" &&
      (this.operations.size > 256 || this.permissions.size > 256)
    ) {
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

  /** Rejects policies that grant unknown permissions or invalid permission scopes. */
  validatePolicy(policy: Infer<typeof policySchema>): void {
    validate(policySchema, policy);
    for (const source of [
      policy.backend,
      ...policy.views.map((view) => view.host),
    ]) {
      for (const grant of source.permissions) {
        const permission = this.permissions.get(
          typeof grant === "string" ? grant : grant.identifier,
        );
        if (!permission) {
          fail("Policy references an unregistered permission.");
        }
        if (typeof grant === "string") {
          if (permission.scope) {
            fail("Scoped permission requires explicit allow scopes.");
          }
        } else if (permission.scope) {
          for (const scope of [
            ...(grant.allow ?? []),
            ...(grant.deny ?? []),
          ]) {
            validate(permission.scope, scope);
          }
        } else if (grant.allow !== undefined || grant.deny !== undefined) {
          fail("Unscoped permission cannot specify allow or deny scopes.");
        }
      }
    }
  }

  /**
   * Checks grants for an operation. Matching deny scopes override all allow
   * scopes; scoped permissions need at least one matching allow scope.
   * Throws UNSUPPORTED if the operation is not registered.
   */
  allowed(
    source: HostPermissions,
    call: HostCall,
    matches: PermissionMatcher,
  ): boolean {
    const operation = this.operation(call.operation);
    const permission = this.permissions.get(operation.permission);
    if (!permission) {
      fail("Unregistered operation permission.");
    }
    let allowed = false;
    for (const grant of source.permissions) {
      if (typeof grant === "string") {
        if (grant === operation.permission && !permission.scope) {
          allowed = true;
        }
      } else if (grant.identifier === operation.permission) {
        if (!permission.scope) {
          allowed = true;
        } else {
          if (
            grant.deny?.some((scope) =>
              matches(operation.permission, call.payload, scope),
            )
          ) {
            return false;
          }
          if (
            grant.allow?.some((scope) =>
              matches(operation.permission, call.payload, scope),
            )
          ) {
            allowed = true;
          }
        }
      }
    }
    return allowed;
  }
}
