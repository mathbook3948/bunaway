import {
  type Infer,
  type JsonValue,
  NativeRegistry,
  type PermissionContract,
  type PermissionMatcher,
  type Schema,
} from "@bunaway/protocol";
import type { NativeInvokeOptions } from "#transport";

export type {
  Infer,
  JsonValue,
  NativePluginContract,
  PermissionMatcher,
  Schema,
} from "@bunaway/protocol";
export { BunawayError } from "@bunaway/protocol";
export type { NativeInvokeOptions } from "#transport";

const optionalField = Symbol("optional field");
type OptionalField<S extends Schema> = { readonly [optionalField]: S };
type Field = Schema | OptionalField<Schema>;
type ObjectSchema<P extends Record<string, Field>> = {
  readonly type: "object";
  readonly properties: {
    readonly [K in keyof P as K extends string | number
      ? `${K}`
      : never]: P[K] extends OptionalField<infer S> ? S : P[K];
  };
  readonly required: readonly {
    [K in keyof P]: P[K] extends OptionalField<Schema>
      ? never
      : K extends string | number
        ? `${K}`
        : never;
  }[keyof P][];
  readonly additionalProperties: false;
};

/** Small constructors for the existing JSON schemas. Object fields are required by default. */
export const s = Object.freeze({
  object<const P extends Record<string, Field>>(fields: P): ObjectSchema<P> {
    const entries = Object.entries(fields);
    return {
      type: "object",
      properties: Object.fromEntries(
        entries.map(([key, field]) => [key, optionalField in field ? field[optionalField] : field]),
      ),
      required: entries.filter(([, field]) => !(optionalField in field)).map(([key]) => key),
      additionalProperties: false,
    } as unknown as ObjectSchema<P>;
  },
  optional<const S extends Schema>(schema: S): OptionalField<S> {
    return { [optionalField]: schema };
  },
  string(options: Pick<Schema, "maxLength" | "pattern"> = {}) {
    return { type: "string", ...options } as const;
  },
  enum<const T extends readonly string[]>(values: T) {
    return { enum: values };
  },
  array<const S extends Schema>(
    items: S,
    options: Pick<Schema, "minItems" | "maxItems" | "uniqueItems"> = {},
  ) {
    return { type: "array", items, ...options } as const;
  },
  integer(options: Pick<Schema, "minimum" | "maximum"> = {}) {
    return { type: "integer", ...options } as const;
  },
  boolean() {
    return { type: "boolean" } as const;
  },
  null() {
    return { const: null } as const;
  },
  json() {
    return {};
  },
});

export type NativeEnvironment = {
  dataRoot: string;
  capabilities: {
    name: string;
    support: "supported" | "experimental" | "unsupported";
    permission: "unknown" | "not-required";
  }[];
};
export type NativeAdapter = {
  execute(operation: string, input: JsonValue, source: string): JsonValue;
  dispose(): void | Promise<void>;
};
export type NativeOperationDefinition = {
  readonly input: Schema;
  readonly output: Schema;
  readonly permission: string;
  readonly osPermission?: "not-required";
};
export type NativePluginDefinition = {
  readonly name: string;
  readonly version: string;
  readonly operations: Readonly<Record<string, NativeOperationDefinition>>;
  readonly scopes?: Readonly<Record<string, Schema>>;
  readonly matches?: PermissionMatcher;
};
export type NativePluginAPI<O extends Record<string, NativeOperationDefinition>> = {
  readonly [K in keyof O]: (
    input: Infer<O[K]["input"]>,
    options?: NativeInvokeOptions,
  ) => Promise<Infer<O[K]["output"]>>;
};
type NativeOperation<D extends NativePluginDefinition> = {
  [K in keyof D["operations"] & (string | number)]: {
    readonly name: `${D["name"]}.${K}`;
    readonly permission: `${D["name"]}:${D["operations"][K]["permission"]}`;
    readonly input: D["operations"][K]["input"];
    readonly output: D["operations"][K]["output"];
    readonly osPermission?: NonNullable<D["operations"][K]["osPermission"]>;
  };
}[keyof D["operations"] & (string | number)];

/** Declare operations once and create their environment-specific callers. */
export function defineNativePlugin<const D extends NativePluginDefinition>(definition: D) {
  const { operations: definitions, scopes, ...metadata } = definition;
  const permissions = new Map<string, PermissionContract>();
  const operations = Object.entries(definitions).map(([key, operation]) => {
    const permission = `${definition.name}:${operation.permission}`;
    const scope =
      scopes && Object.hasOwn(scopes, operation.permission)
        ? scopes[operation.permission]
        : undefined;
    permissions.set(permission, { name: permission, ...(scope === undefined ? {} : { scope }) });
    return { ...operation, name: `${definition.name}.${key}`, permission };
  }) as NativeOperation<D>[];
  for (const key of Object.keys(scopes ?? {}))
    if (!permissions.has(`${definition.name}:${key}`))
      throw new Error("Plugin scope references an unused permission.");
  const registration = {
    ...metadata,
    native: { operations, permissions: [...permissions.values()] },
  };
  const registry = new NativeRegistry([registration]);
  if (
    registration.native.permissions.some((permission) => permission.scope) &&
    typeof definition.matches !== "function"
  )
    throw new Error("Scoped plugin permissions require matches.");
  const api = Object.fromEntries(
    [...registry.operations.values()].map((operation) => [
      operation.name.slice(definition.name.length + 1),
      async (input: Infer<typeof operation.input>, options?: NativeInvokeOptions) => {
        // Declaration imports never initialize the backend or a WebView connection.
        const { call } = await import("#transport");
        return call(operation, input, options);
      },
    ]),
  ) as unknown as NativePluginAPI<D["operations"]>;
  return { definition: Object.freeze(registration), api: Object.freeze(api) };
}
