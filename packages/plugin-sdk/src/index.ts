import { PLATFORMS } from "@bunaway/plugin-api";
import { isRecord, type JsonValue, NativeRegistry } from "@bunaway/protocol";
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
export {
  attemptAll,
  attemptAllAsync,
  failWithCleanup,
  ResourceOwner,
} from "./cleanup.ts";
export { NativeEventWaiters } from "./native-event-waiters.ts";
export type {
  NativeCallContext,
  NativeHandlerFactory,
  NativeHandlers,
} from "./native-handlers.ts";
export { defineNativeAdapter } from "./native-handlers.ts";
export type { NativeHandlerContext } from "./native-platform.ts";
export type { NativePluginAdapter } from "./native-validation.ts";
export {
  base64CharactersFor,
  base64Schema,
  canonicalBase64Bytes,
  int32Schema,
  nonNegativeInt32Schema,
} from "./schemas.ts";

/** Plugin-originated native events delivered to the app's WebViews. */
export type NativeEventServices = {
  /**
   * Sends one event to every live view whose current document has subscribed to it, or has a
   * subscription request still pending. Only the subscription is checked per emit; the policy was
   * checked when the subscription was made. Events are dropped once the host stops.
   *
   * When `requiredOperation` is given, a view also needs that operation in its host permissions,
   * checked at every emit, so an event that reports readable state is delivered only to views
   * that could read the same state by calling the operation. Without it, only the subscription
   * is checked.
   */
  emit(event: string, payload: JsonValue, requiredOperation?: string): void;
};

/** Host-selected values available when a native adapter is created. */
export type NativeEnvironment = {
  /** Trusted app identity and restart command. Callers cannot select another executable. */
  app?: {
    id: string;
    /**
     * The app's own version as recorded in the package manifest, or `null` when the build did not
     * record one. Hosts always set it; a hand-built environment may omit it, which reads as `null`.
     */
    version?: string | null;
    /**
     * Validated `bunaway.json` `plugins` clauses keyed by plugin name. The host checks only their
     * shape (JSON object, size limit; the CLI also rejects names of plugins that are not installed); each plugin validates its own clause.
     */
    pluginSettings?: Readonly<Record<string, JsonValue>>;
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
  /** Optional event delivery on the macOS host; the Windows host uses its dedicated services. */
  events?: NativeEventServices;
  /** Optional UI-thread menu integration, absent on platforms without native menus. */
  menus?: import("@bunaway/plugin-api/native").NativeMenuServices;
  /** Optional UI-thread controls for the app's existing configured tray icon. */
  tray?: import("@bunaway/plugin-api/native").NativeTrayServices;
  /** Optional modal picker ownership and control dispatch on the UI STA. */
  dialogs?: import("@bunaway/plugin-api/native").NativeDialogServices;
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
  /** Policy validation rejects a grant of this operation to a view; only the backend may hold it. */
  readonly backendOnly?: true;
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
    readonly backendOnly?: true;
    readonly handler: Handler;
  }) => operation;
}
type NativePluginResult<Metadata, API> = API & {
  /** @internal Registration metadata for app composition, CLI discovery and native hosts. */
  readonly _definition: Readonly<
    Metadata & {
      version: string;
      native: {
        operations: {
          name: string;
          backendOnly?: true;
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
/** Names a plugin API must not define: they collide with the registration, promise and JSON protocols. */
const RESERVED_API_NAMES = [
  "_definition",
  "then",
  "toJSON",
];

type PlatformDeclaration = LegacyNativePlatform | NativePlatformDefinition;

/** What a platform declaration contributes to the registered plugin. */
type PlatformParts = {
  schemas: ReadonlyMap<string, NativeOperationDefinition>;
  supportedOperations: readonly string[] | undefined;
  create: NativeAdapterFactory;
};

/** Validate operation schemas and record each qualified name in `names`. */
function readOperationSchemas(
  pluginName: string,
  definitions: Readonly<Record<string, NativeOperationDefinition>>,
  names: Set<string>,
  backendOnly: Set<string>,
) {
  return new Map(
    Object.entries(definitions).map(([name, operation]) => {
      if (RESERVED_API_NAMES.includes(name)) {
        throw new Error(`Reserved native plugin operation name: ${name}.`);
      }
      if (
        !operation ||
        !(operation.input instanceof z.ZodType) ||
        !(operation.output instanceof z.ZodType)
      ) {
        throw new Error("Plugin inputs and outputs must be Zod schemas.");
      }
      if (Object.hasOwn(operation, "handlers")) {
        throw new Error("Declare native handlers inside platform operations.");
      }
      const fullName = `${pluginName}.${name}`;
      names.add(fullName);
      if (operation.backendOnly === true) {
        backendOnly.add(fullName);
      } else if (operation.backendOnly !== undefined) {
        throw new Error("backendOnly must be true when present.");
      }
      return [
        fullName,
        {
          input: operation.input,
          output: operation.output,
        },
      ] as const;
    }),
  );
}

function assertPlatformDeclaration(
  platform: string,
  target: PlatformDeclaration,
): void {
  // Checked as `unknown` so the guard does not narrow the typed declaration.
  const declaration: unknown = target;
  if (
    !PLATFORMS.some((supported) => supported === platform) ||
    !isRecord(declaration) ||
    Object.hasOwn(target, "execution") ||
    (target.thread !== undefined &&
      target.thread !== "worker" &&
      target.thread !== "ui")
  ) {
    throw new Error("Invalid native plugin platform declaration.");
  }
}

/** An existing adapter factory: it serves the plugin-wide schemas and may list the operations it supports. */
function readFactoryPlatform(
  pluginName: string,
  target: LegacyNativePlatform,
  legacySchemas: ReadonlyMap<string, NativeOperationDefinition> | undefined,
): PlatformParts {
  if (typeof target.create !== "function") {
    throw new Error("Native plugin platforms require an adapter factory.");
  }
  if (
    !legacySchemas ||
    Object.hasOwn(target, "initialize") ||
    Object.hasOwn(target, "dispose")
  ) {
    throw new Error("Native handlers require a lifecycle platform.");
  }
  const create = target.create;
  let supportedOperations: readonly string[] | undefined;
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
          !legacySchemas.has(`${pluginName}.${operation}`),
      ))
  ) {
    throw new Error("Invalid native plugin operation support.");
  }
  return {
    schemas: legacySchemas,
    supportedOperations,
    create,
  };
}

/** A lifecycle platform: its own operation schemas, handlers and optional initialize, dispose and busy hooks. */
function readLifecyclePlatform(
  pluginName: string,
  target: NativePlatformDefinition,
  hasLegacyDefinitions: boolean,
  names: Set<string>,
  backendOnly: Set<string>,
): PlatformParts {
  if (
    hasLegacyDefinitions ||
    (target.initialize !== undefined &&
      typeof target.initialize !== "function") ||
    (target.dispose !== undefined && typeof target.dispose !== "function") ||
    (target.busy !== undefined && typeof target.busy !== "function") ||
    !target.operations ||
    typeof target.operations !== "object" ||
    Array.isArray(target.operations)
  ) {
    throw new Error("Invalid native platform lifecycle.");
  }
  const schemas = readOperationSchemas(
    pluginName,
    target.operations,
    names,
    backendOnly,
  );
  const handlers = new Map<string, NativeHandler>();
  for (const [name, operation] of Object.entries(target.operations)) {
    const declared: unknown = operation;
    if (!isRecord(declared)) {
      throw new Error("Invalid native operation handler.");
    }
    const handler: unknown = Reflect.get(declared, "handler");
    if (typeof handler !== "function") {
      throw new Error("Invalid native operation handler.");
    }
    // Dynamic dispatch is erased here; this platform's schemas surround every invocation.
    handlers.set(name, handler as NativeHandler);
  }
  return {
    schemas,
    supportedOperations: [
      ...handlers.keys(),
    ],
    create: handlerAdapterFactory(target, handlers),
  };
}

/** Freeze one platform's metadata; the validating factory is a non-enumerable property. */
function freezePlatform(
  target: PlatformDeclaration,
  { schemas, supportedOperations, create }: PlatformParts,
) {
  return Object.freeze(
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
  );
}

/** Build the caller API from the registered operations, or from the plugin's `calls` mapping. */
function createPublicAPI(
  registry: NativeRegistry,
  pluginName: string,
  calls: ((operations: never) => object) | undefined,
) {
  const api = Object.fromEntries(
    [
      ...registry.operations.values(),
    ].map((operation) => [
      operation.name.slice(pluginName.length + 1),
      async (input: JsonValue, options?: NativeInvokeOptions) => {
        const { call } = await import("#transport");
        return call(operation, input, options);
      },
    ]),
  );
  // Overloads preserve each operation's schema types; the implementation erases them at this call.
  const publicAPI = calls ? calls(Object.freeze(api) as never) : api;
  if (
    !publicAPI ||
    (typeof publicAPI !== "object" && typeof publicAPI !== "function") ||
    RESERVED_API_NAMES.some((name) => name in publicAPI) ||
    !Object.isExtensible(publicAPI)
  ) {
    throw new Error(
      "Native plugin calls must return an extensible API without reserved properties.",
    );
  }
  return publicAPI;
}

/**
 * Declare input/output schemas and a handler inside each platform's operations.
 * Initialization, parsing, execution and cleanup stay on the owning host thread.
 * Support and caller names come from operation keys; schemas remain local to each platform.
 * Imports never initialize native resources or request OS consent.
 * The result can be default-exported, registered in defineApp and called directly.
 * Optional calls maps the generated operations to a fresh public API or callable function.
 * The SDK freezes that API and attaches non-enumerable internal registration metadata.
 */
export function defineNativePlugin<
  const Metadata extends NativePluginMetadata,
  const Platforms extends Partial<
    Record<import("@bunaway/plugin-api").Platform, NativePlatformDefinition>
  >,
  API extends object = PlatformAPI<Platforms>,
>(
  definition: Metadata & {
    readonly platforms: Platforms & {
      readonly [Platform in keyof Platforms]: Platforms[Platform] extends NativePlatformDefinition
        ? CheckedPlatform<Platforms[Platform]>
        : never;
    };
  },
  calls?: (operations: PlatformAPI<Platforms>) => API,
): NativePluginResult<PluginMetadata<Metadata>, API>;
/** Existing low-level adapters and defineNativeAdapter keep their schema declaration. */
export function defineNativePlugin<
  const Metadata extends NativePluginMetadata,
  const O extends Record<string, NativeOperationDefinition>,
  API extends object = NativePluginAPI<O>,
>(
  definition: Metadata & {
    readonly operations: O;
    readonly platforms?: Readonly<
      Partial<
        Record<import("@bunaway/plugin-api").Platform, LegacyNativePlatform>
      >
    >;
  },
  calls?: (operations: NativePluginAPI<O>) => API,
): NativePluginResult<PluginMetadata<Metadata>, API>;
export function defineNativePlugin(
  definition: NativePluginDefinition,
  calls?: (operations: never) => object,
  // The plugin builder supplies the package version; source imports use development.
  version = "development",
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
  const backendOnly = new Set<string>();
  const legacySchemas =
    legacyDefinitions &&
    readOperationSchemas(
      definition.name,
      legacyDefinitions,
      names,
      backendOnly,
    );
  const nativePlatforms = Object.fromEntries(
    Object.entries(platforms).map(([platform, target]) => {
      assertPlatformDeclaration(platform, target);
      const parts =
        "create" in target
          ? readFactoryPlatform(definition.name, target, legacySchemas)
          : readLifecyclePlatform(
              definition.name,
              target,
              !!legacyDefinitions,
              names,
              backendOnly,
            );
      return [
        platform,
        freezePlatform(target, parts),
      ];
    }),
  );
  const registration = {
    ...metadata,
    version,
    nativePlatforms: Object.freeze(nativePlatforms),
    native: {
      operations: [
        ...names,
      ].map((name) => ({
        name,
        ...(backendOnly.has(name)
          ? {
              backendOnly: true as const,
            }
          : {}),
      })),
    },
  };
  const registry = new NativeRegistry([
    registration,
  ]);
  const publicAPI = createPublicAPI(registry, definition.name, calls);
  return Object.freeze(
    Object.defineProperty(publicAPI, "_definition", {
      value: Object.freeze(registration),
    }),
  );
}
