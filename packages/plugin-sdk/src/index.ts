import { PLATFORMS } from "@bunaway/plugin-api";
import {
  type Infer,
  type JsonValue,
  NativeRegistry,
  type Schema,
} from "@bunaway/protocol";
import type { NativeInvokeOptions } from "#transport";

export type {
  Infer,
  JsonValue,
  NativePluginContract,
  Schema,
} from "@bunaway/protocol";
export { BunawayError } from "@bunaway/protocol";
export type { NativeInvokeOptions } from "#transport";

const optionalField = Symbol("optional field");
type OptionalField<S extends Schema> = {
  readonly [optionalField]: S;
};
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

/**
 * Build JSON Schema fragments for plugin inputs and outputs. Object fields are
 * required by default, and extra fields are rejected.
 */
export const s = Object.freeze({
  object<const P extends Record<string, Field>>(fields: P): ObjectSchema<P> {
    const entries = Object.entries(fields);
    return {
      type: "object",
      properties: Object.fromEntries(
        entries.map(([key, field]) => [
          key,
          optionalField in field ? field[optionalField] : field,
        ]),
      ),
      required: entries
        .filter(([, field]) => !(optionalField in field))
        .map(([key]) => key),
      additionalProperties: false,
    } as unknown as ObjectSchema<P>;
  },
  /** Mark an object field optional while keeping its schema unchanged. */
  optional<const S extends Schema>(schema: S): OptionalField<S> {
    return {
      [optionalField]: schema,
    };
  },
  string(options: Pick<Schema, "maxLength" | "pattern"> = {}) {
    return {
      type: "string",
      ...options,
    } as const;
  },
  enum<const T extends readonly string[]>(values: T) {
    return {
      enum: values,
    };
  },
  array<const S extends Schema>(
    items: S,
    options: Pick<Schema, "minItems" | "maxItems" | "uniqueItems"> = {},
  ) {
    return {
      type: "array",
      items,
      ...options,
    } as const;
  },
  integer(options: Pick<Schema, "minimum" | "maximum"> = {}) {
    return {
      type: "integer",
      ...options,
    } as const;
  },
  boolean() {
    return {
      type: "boolean",
    } as const;
  },
  null() {
    return {
      const: null,
    } as const;
  },
  json() {
    return {};
  },
});

/** Host-selected values available when a native adapter is created. */
export type NativeEnvironment = {
  /** Trusted app identity and restart command. Callers cannot select another executable. */
  app?: {
    id: string;
    launch: {
      mode: "development" | "packaged";
      executablePath: string;
      args: string[];
    };
  };
  /** Window services supplied by the host on its native UI thread. */
  windows?: import("@bunaway/plugin-api/native").NativeWindowServices;
  /** Host-owned data directory used for app-scoped files. */
  dataRoot: string;
  /** Registered operations and their platform support states. */
  capabilities: {
    name: string;
    support: "supported" | "experimental" | "unsupported";
  }[];
};
/** Operations supplied by a platform adapter and owned by the host lifecycle. */
export type NativeAdapter = {
  /** Run an operation in the I/O worker or as a UI adapter fallback. */
  execute(operation: string, input: JsonValue, source: string): JsonValue;
  /** Run an operation that needs UI-thread services; the host awaits its result. */
  executeUI?(
    operation: string,
    input: JsonValue,
    source: string,
    context: {
      requestId: string;
      /** Permission grants available to this host context. */
      permissions: import("@bunaway/protocol").Policy["backend"];
      /** Aborted when the UI call is cancelled, its context is revoked, or the host stops. */
      signal?: AbortSignal;
    },
  ): JsonValue | Promise<JsonValue>;
  /** Report whether pending adapter work should delay host auto-close. */
  busy?(): boolean;
  /** Release resources created while preparing this adapter. */
  dispose(): void | Promise<void>;
};
/** Create an adapter on its owning host worker; importing the factory must not initialize OS resources. */
export type NativeAdapterFactory = (
  environment: NativeEnvironment,
) => NativeAdapter;
/** Input and output schemas for one named native operation. */
export type NativeOperationDefinition = {
  /** Schema checked for each call's input. */
  readonly input: Schema;
  /** Schema checked for the operation result. */
  readonly output: Schema;
};
/** Declarative contract used to register operations and construct their callers. */
export type NativePluginDefinition = {
  /** Plugin name used as the prefix for operation and permission identifiers. */
  readonly name: string;
  /** Platform factories imported from src/platforms/<platform>.ts. Omit unsupported platforms. */
  readonly platforms?: Readonly<
    Partial<
      Record<
        import("@bunaway/plugin-api").Platform,
        {
          readonly execution: "io" | "ui";
          readonly create: NativeAdapterFactory;
          /** Short operation names implemented on this platform; omission means all declared operations. */
          readonly operations?: readonly string[];
        }
      >
    >
  >;
  /** Operations keyed by the caller-facing method name. */
  readonly operations: Readonly<Record<string, NativeOperationDefinition>>;
};
/** Promise-based caller shape inferred from a plugin's operation schemas. */
export type NativePluginAPI<
  O extends Record<string, NativeOperationDefinition>,
> = {
  readonly [K in keyof O]: (
    input: Infer<O[K]["input"]>,
    options?: NativeInvokeOptions,
  ) => Promise<Infer<O[K]["output"]>>;
};
type NativeOperation<D extends NativePluginDefinition> = {
  [K in keyof D["operations"] & (string | number)]: {
    readonly name: `${D["name"]}.${K}`;
    readonly input: D["operations"][K]["input"];
    readonly output: D["operations"][K]["output"];
  };
}[keyof D["operations"] & (string | number)];

/**
 * Define operations and return the validated host contract with typed `api`
 * callers.
 * Policies grant access by operation name. Applications own resource access
 * rules. Plugins own OS consent and may request it
 * inside an explicitly invoked operation; declaration imports never prompt.
 * The declaration is checked immediately, before any caller is created.
 * Plugin builds record the package.json version; direct source imports use
 * `development` until the package is built.
 */
export function defineNativePlugin<const D extends NativePluginDefinition>(
  definition: D,
) {
  const { operations: definitions, platforms = {}, ...metadata } = definition;
  // Build metadata must not become Core's incompatible-platform startup restriction.
  const nativePlatforms = Object.fromEntries(
    Object.entries(platforms).map(([platform, target]) => {
      if (
        !PLATFORMS.some((supported) => supported === platform) ||
        !target ||
        ![
          "io",
          "ui",
        ].includes(target.execution)
      ) {
        throw new Error("Invalid native plugin platform declaration.");
      }
      if (typeof target.create !== "function") {
        throw new Error("Native plugin platforms require an adapter factory.");
      }
      if (
        target.operations !== undefined &&
        (!Array.isArray(target.operations) ||
          new Set(target.operations).size !== target.operations.length ||
          target.operations.some(
            (operation) =>
              typeof operation !== "string" ||
              !Object.hasOwn(definitions, operation),
          ))
      ) {
        throw new Error("Invalid native plugin operation support.");
      }
      return [
        platform,
        Object.freeze(
          Object.defineProperty(
            {
              execution: target.execution,
              ...(target.operations === undefined
                ? {}
                : {
                    operations: Object.freeze([
                      ...target.operations,
                    ]),
                  }),
            },
            "create",
            {
              // Factories stay local to each worker; JSON and structured clone carry only metadata.
              value: target.create,
            },
          ),
        ) as {
          readonly execution: "io" | "ui";
          readonly operations?: readonly string[];
          readonly create: NativeAdapterFactory;
        },
      ];
    }),
  );
  const operations = Object.entries(definitions).map(([key, operation]) => {
    return {
      ...operation,
      name: `${definition.name}.${key}`,
    };
  }) as NativeOperation<D>[];
  const registration = {
    ...metadata,
    // Package builds replace this source-only marker with their package.json version.
    version: "development",
    nativePlatforms: Object.freeze(nativePlatforms),
    native: {
      operations,
    },
  };
  const registry = new NativeRegistry([
    registration,
  ]);
  const api = Object.fromEntries(
    [
      ...registry.operations.values(),
    ].map((operation) => [
      operation.name.slice(definition.name.length + 1),
      async (
        input: Infer<typeof operation.input>,
        options?: NativeInvokeOptions,
      ) => {
        // Declaration imports never initialize the backend or a WebView connection.
        const { call } = await import("#transport");
        return call(operation, input, options);
      },
    ]),
  ) as unknown as NativePluginAPI<D["operations"]>;
  return {
    definition: Object.freeze(registration),
    api: Object.freeze(api),
  };
}
