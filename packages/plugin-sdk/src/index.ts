import { PLATFORMS } from "@bunaway/plugin-api";
import { type JsonValue, NativeRegistry } from "@bunaway/protocol";
import { z } from "zod";
import type { NativeInvokeOptions } from "#transport";
import {
  handlerAdapterFactory,
  type NativeHandler,
  type NativeHandlerContext,
  type NativePlatformDefinition,
} from "./native-platform.ts";
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
export type { NativeHandlerContext } from "./native-platform.ts";
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
export type NativeAdapterFactory = (environment: NativeEnvironment) => Omit<
  NativeAdapter,
  "execute"
> & {
  execute(
    operation: string,
    input: JsonValue,
    source: string,
  ): JsonValue | Promise<JsonValue>;
};
/** Input and output schemas for one named native operation. */
export type NativeOperationDefinition = {
  /** Parsed with parseAsync before execution; raw and parsed values must be JSON. */
  readonly input: z.ZodType;
  /** Parsed with parseAsync after execution; raw and parsed values must be JSON. */
  readonly output: z.ZodType;
};
/** Metadata shared by both platform declarations and existing adapter factories. */
type NativePluginMetadata = {
  readonly name: string;
  readonly events?: NonNullable<
    import("@bunaway/plugin-api").PluginDefinition["events"]
  >;
};
type LegacyNativePlatform = {
  readonly thread?: "worker" | "ui";
  readonly create: NativeAdapterFactory;
  readonly operations?: readonly string[];
};
/** Declare complete operations per platform, or schemas for an existing adapter factory. */
export type NativePluginDefinition = NativePluginMetadata &
  (
    | {
        readonly platforms: Readonly<
          Partial<
            Record<
              import("@bunaway/plugin-api").Platform,
              NativePlatformDefinition
            >
          >
        >;
      }
    | {
        readonly operations: Readonly<
          Record<string, NativeOperationDefinition>
        >;
        readonly platforms?: Readonly<
          Partial<
            Record<import("@bunaway/plugin-api").Platform, LegacyNativePlatform>
          >
        >;
      }
  );
/** Promise-based caller shape inferred from the declared operation schemas. */
export type NativePluginAPI<
  O extends Record<string, NativeOperationDefinition>,
> = {
  readonly [K in keyof O]: (
    input: z.input<O[K]["input"]>,
    options?: NativeInvokeOptions,
  ) => Promise<z.output<O[K]["output"]>>;
};
/** Type a platform command from its schemas and the instance returned by initialize. */
export function defineNativeOperation<Instance>() {
  return <
    const Input extends z.ZodType,
    const Output extends z.ZodType,
    Handler extends (
      input: z.output<Input>,
      context: NativeHandlerContext<Instance>,
    ) => z.input<Output> | Promise<z.input<Output>>,
  >(operation: {
    readonly input: Input;
    readonly output: Output;
    readonly handler: Handler;
  }) => operation;
}
type NativePluginResult<Metadata, API> = {
  readonly definition: Readonly<
    Metadata & {
      version: string;
      native: {
        operations: {
          name: string;
        }[];
      };
      nativePlatforms: Readonly<
        Partial<
          Record<
            import("@bunaway/plugin-api").Platform,
            {
              readonly thread: "worker" | "ui";
              readonly operations?: readonly string[];
              readonly create: (
                environment: NativeEnvironment,
              ) => NativePluginAdapter;
            }
          >
        >
      >;
    }
  >;
  readonly api: API;
};
type PlatformInstance<Target> = Target extends {
  initialize: (environment: NativeEnvironment) => infer Instance;
}
  ? Instance
  : undefined;
type PlatformOperationNames<Platforms> = {
  [Platform in keyof Platforms]: Platforms[Platform] extends NativePlatformDefinition
    ? keyof Platforms[Platform]["operations"]
    : never;
}[keyof Platforms];
type PlatformOperation<Platforms, Name> = {
  [Platform in keyof Platforms]: Platforms[Platform] extends NativePlatformDefinition
    ? Name extends keyof Platforms[Platform]["operations"]
      ? Platforms[Platform]["operations"][Name]
      : never
    : never;
}[keyof Platforms];
/** Project only caller inputs/results; implementation and schema types stay private. */
type PlatformAPI<Platforms> = {
  readonly [Name in PlatformOperationNames<Platforms> & string]: (
    input: z.input<
      Extract<
        PlatformOperation<Platforms, Name>,
        NativeOperationDefinition
      >["input"]
    >,
    options?: NativeInvokeOptions,
  ) => Promise<
    z.output<
      Extract<
        PlatformOperation<Platforms, Name>,
        NativeOperationDefinition
      >["output"]
    >
  >;
};
/** Materialize metadata before declaration emit, without retaining the platform type argument. */
type PluginMetadata<Definition> = {
  [Key in keyof Definition as Key extends "platforms" | "operations"
    ? never
    : Key]: Definition[Key];
};
type CheckedPlatform<Target extends NativePlatformDefinition> = {
  readonly initialize?: (
    environment: NativeEnvironment,
  ) => Exclude<PlatformInstance<Target>, PromiseLike<unknown>>;
  readonly dispose?: (
    instance: PlatformInstance<Target>,
  ) => void | Promise<void>;
  readonly busy?: (instance: PlatformInstance<Target>) => boolean;
  readonly operations: {
    readonly [Name in keyof Target["operations"]]: {
      readonly handler: (
        input: z.output<Target["operations"][Name]["input"]>,
        context: NativeHandlerContext<PlatformInstance<Target>>,
      ) =>
        | z.input<Target["operations"][Name]["output"]>
        | Promise<z.input<Target["operations"][Name]["output"]>>;
    };
  };
};
/**
 * Declare input/output schemas and a handler inside each platform's operations.
 * Initialization, parsing, execution and cleanup stay on the owning host thread.
 * Support and caller names come from operation keys; schemas remain local to each platform.
 * Imports never initialize native resources or request OS consent.
 */
export function defineNativePlugin<
  const Metadata extends NativePluginMetadata,
  const Platforms extends Partial<
    Record<import("@bunaway/plugin-api").Platform, NativePlatformDefinition>
  >,
>(
  definition: Metadata & {
    readonly platforms: Platforms & {
      readonly [Platform in keyof Platforms]: Platforms[Platform] extends NativePlatformDefinition
        ? CheckedPlatform<Platforms[Platform]>
        : never;
    };
  },
): NativePluginResult<PluginMetadata<Metadata>, PlatformAPI<Platforms>>;
/** Existing low-level adapters and defineNativeAdapter keep their schema declaration. */
export function defineNativePlugin<
  const Metadata extends NativePluginMetadata,
  const O extends Record<string, NativeOperationDefinition>,
>(
  definition: Metadata & {
    readonly operations: O;
    readonly platforms?: Readonly<
      Partial<
        Record<import("@bunaway/plugin-api").Platform, LegacyNativePlatform>
      >
    >;
  },
): NativePluginResult<PluginMetadata<Metadata>, NativePluginAPI<O>>;
export function defineNativePlugin(
  definition: NativePluginDefinition,
): unknown {
  const legacyDefinitions =
    "operations" in definition ? definition.operations : undefined;
  const {
    platforms: declaredPlatforms,
    operations: _operations,
    ...metadata
  } = {
    ...definition,
    operations: legacyDefinitions,
  };
  const platforms = declaredPlatforms ?? {};
  const names = new Set<string>();
  const readSchemas = (
    definitions: Readonly<Record<string, NativeOperationDefinition>>,
  ) =>
    new Map(
      Object.entries(definitions).map(([name, operation]) => {
        if (
          !operation ||
          !(operation.input instanceof z.ZodType) ||
          !(operation.output instanceof z.ZodType)
        ) {
          throw new Error("Plugin inputs and outputs must be Zod schemas.");
        }
        if (Object.hasOwn(operation, "handlers")) {
          throw new Error(
            "Declare native handlers inside platform operations.",
          );
        }
        const fullName = `${definition.name}.${name}`;
        names.add(fullName);
        return [
          fullName,
          {
            input: operation.input,
            output: operation.output,
          },
        ] as const;
      }),
    );
  const legacySchemas = legacyDefinitions && readSchemas(legacyDefinitions);
  const nativePlatforms = Object.fromEntries(
    Object.entries(platforms).map(([platform, target]) => {
      if (
        !PLATFORMS.some((supported) => supported === platform) ||
        !target ||
        typeof target !== "object" ||
        Array.isArray(target) ||
        Object.hasOwn(target, "execution") ||
        (target.thread !== undefined &&
          target.thread !== "worker" &&
          target.thread !== "ui")
      ) {
        throw new Error("Invalid native plugin platform declaration.");
      }
      let schemas: ReadonlyMap<string, NativeOperationDefinition>;
      let supportedOperations: readonly string[] | undefined;
      let create: NativeAdapterFactory;
      if ("create" in target) {
        if (typeof target.create !== "function") {
          throw new Error(
            "Native plugin platforms require an adapter factory.",
          );
        }
        if (
          !legacySchemas ||
          Object.hasOwn(target, "initialize") ||
          Object.hasOwn(target, "dispose")
        ) {
          throw new Error("Native handlers require a lifecycle platform.");
        }
        schemas = legacySchemas;
        create = target.create;
        if ("operations" in create) {
          if (target.operations !== undefined) {
            throw new Error(
              "Handler maps infer support; omit the platform operations list.",
            );
          }
          supportedOperations = (
            create as import("./native-handlers.ts").NativeHandlerFactory
          ).operations;
        } else {
          supportedOperations = target.operations;
        }
        if (
          supportedOperations !== undefined &&
          (!Array.isArray(supportedOperations) ||
            new Set(supportedOperations).size !== supportedOperations.length ||
            supportedOperations.some(
              (operation) =>
                typeof operation !== "string" ||
                !schemas.has(`${definition.name}.${operation}`),
            ))
        ) {
          throw new Error("Invalid native plugin operation support.");
        }
      } else {
        if (
          legacyDefinitions ||
          (target.initialize !== undefined &&
            typeof target.initialize !== "function") ||
          (target.dispose !== undefined &&
            typeof target.dispose !== "function") ||
          (target.busy !== undefined && typeof target.busy !== "function") ||
          !target.operations ||
          typeof target.operations !== "object" ||
          Array.isArray(target.operations)
        ) {
          throw new Error("Invalid native platform lifecycle.");
        }
        schemas = readSchemas(target.operations);
        const handlers = new Map<string, NativeHandler>();
        for (const [name, operation] of Object.entries(target.operations)) {
          if (
            !operation ||
            typeof operation !== "object" ||
            Array.isArray(operation)
          ) {
            throw new Error("Invalid native operation handler.");
          }
          const handler: unknown = Reflect.get(operation, "handler");
          if (typeof handler !== "function") {
            throw new Error("Invalid native operation handler.");
          }
          // Dynamic dispatch is erased here; this platform's schemas surround every invocation.
          handlers.set(name, handler as NativeHandler);
        }
        supportedOperations = [
          ...handlers.keys(),
        ];
        create = handlerAdapterFactory(target, handlers);
      }
      return [
        platform,
        Object.freeze(
          Object.defineProperty(
            {
              thread: target.thread ?? "worker",
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
              // Executable factories stay local; JSON and structured clone carry only metadata.
              value: (environment: NativeEnvironment) =>
                validatedAdapter(create(environment), schemas),
            },
          ),
        ),
      ];
    }),
  );
  const registration = {
    ...metadata,
    version: "development",
    nativePlatforms: Object.freeze(nativePlatforms),
    native: {
      operations: [
        ...names,
      ].map((name) => ({
        name,
      })),
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
        const { call } = await import("#transport");
        return call(operation, input, options);
      },
    ]),
  );
  return {
    definition: Object.freeze(registration),
    api: Object.freeze(api),
  };
}
