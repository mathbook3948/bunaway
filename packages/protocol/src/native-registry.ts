import { BunawayError } from "./contracts.ts";
import type {
  HostCall,
  HostOperationContract,
  NativePluginContract,
} from "./host-api.ts";
import { checkPluginSchema } from "./plugin-schema.ts";
import { policySchema } from "./schema.ts";
import { type Infer, type JsonValue, validate } from "./validation.ts";

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
        try {
          checkPluginSchema(operation.input);
          checkPluginSchema(operation.output);
        } catch {
          fail("Invalid plugin schema.");
        }
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
