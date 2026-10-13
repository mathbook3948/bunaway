import { PLATFORMS } from "@bunaway/plugin-api";
import { type JsonValue, NativeRegistry } from "@bunaway/protocol";
import { z } from "zod";
import type { NativeInvokeOptions } from "#transport";
import {
  type NativePluginAdapter,
  validatedAdapter,
} from "./native-validation.ts";

export type {
  JsonValue,
  NativePluginContract,
} from "@bunaway/protocol";
export { BunawayError } from "@bunaway/protocol";
export type { NativeInvokeOptions } from "#transport";
export { NativeEventWaiters } from "./native-event-waiters.ts";
export type {
  NativeCallContext,
  NativeHandlerFactory,
  NativeHandlers,
} from "./native-handlers.ts";
export { defineNativeAdapter } from "./native-handlers.ts";
export type { NativePluginAdapter } from "./native-validation.ts";

/** Host-selected values available when a native adapter is created. */
export type NativeEnvironment = {
  /** Trusted app identity and restart command. Callers cannot select another executable. */
  app?: {
    id: string;
    /** Validated desktop tray permits hidden startup; absence does not grant support. */
    supportsHiddenStart?: boolean;
    launch: {
      mode: "development" | "packaged";
      executablePath: string;
      args: string[];
    };
  };
  /** Window services supplied by the host on its native UI thread. */
  windows?: import("@bunaway/plugin-api/native").NativeWindowServices;
  /** Optional global shortcut message-window and event services on the native UI thread. */
  shortcuts?: import("@bunaway/plugin-api/native").NativeShortcutServices;
  /** Optional UI-thread menu integration, absent on platforms without native menus. */
  menus?: import("@bunaway/plugin-api/native").NativeMenuServices;
  /** Optional UI-thread controls for the app's existing configured tray icon. */
  tray?: import("@bunaway/plugin-api/native").NativeTrayServices;
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
      /** Host rechecks live authority immediately before entering the native adapter. */
      beforeExecute?(): void;
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
  /** Parsed with parseAsync before execution; raw and parsed values must be JSON. */
  readonly input: z.ZodType;
  /** Parsed with parseAsync after execution; raw and parsed values must be JSON. */
  readonly output: z.ZodType;
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
  /** Events declared alongside operations in the same registration. */
  readonly events?: NonNullable<
    import("@bunaway/plugin-api").PluginDefinition["events"]
  >;
  /** Operations keyed by the caller-facing method name. */
  readonly operations: Readonly<Record<string, NativeOperationDefinition>>;
};
/** Promise-based caller shape inferred from a plugin's operation schemas. */
export type NativePluginAPI<
  O extends Record<string, NativeOperationDefinition>,
> = {
  readonly [K in keyof O]: (
    input: z.input<O[K]["input"]>,
    options?: NativeInvokeOptions,
  ) => Promise<z.output<O[K]["output"]>>;
};
/**
 * Define operations and return the validated host contract with typed `api`
 * callers. Input and output parsing runs on the owning adapter, never during transport.
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
  // Keep executable schemas local; copying pairs prevents later declaration replacement.
  const schemas = new Map(
    Object.entries(definitions).map(([name, operation]) => {
      if (
        !(operation.input instanceof z.ZodType) ||
        !(operation.output instanceof z.ZodType)
      ) {
        throw new Error("Plugin inputs and outputs must be Zod schemas.");
      }
      return [
        `${definition.name}.${name}`,
        {
          input: operation.input,
          output: operation.output,
        },
      ] as const;
    }),
  );
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
      const supportedOperations =
        "operations" in target.create
          ? (
              target.create as import("./native-handlers.ts").NativeHandlerFactory
            ).operations
          : target.operations;
      if (target.operations !== undefined && "operations" in target.create) {
        throw new Error(
          "Handler maps infer support; omit the platform operations list.",
        );
      }
      if (
        supportedOperations !== undefined &&
        (!Array.isArray(supportedOperations) ||
          new Set(supportedOperations).size !== supportedOperations.length ||
          supportedOperations.some(
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
              ...(supportedOperations === undefined
                ? {}
                : {
                    operations: Object.freeze([
                      ...supportedOperations,
                    ]),
                  }),
            },
            "create",
            {
              // Factories stay local to each worker; JSON and structured clone carry only metadata.
              value: (environment: NativeEnvironment) =>
                validatedAdapter(target.create(environment), schemas),
            },
          ),
        ) as {
          readonly execution: "io" | "ui";
          readonly operations?: readonly string[];
          readonly create: (
            environment: NativeEnvironment,
          ) => NativePluginAdapter;
        },
      ];
    }),
  );
  const operations = [
    ...schemas.keys(),
  ].map((name) => ({
    name,
  }));
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
      async (input: JsonValue, options?: NativeInvokeOptions) => {
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
