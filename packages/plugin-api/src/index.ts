import type {
  CancellationSignal,
  HostAPI,
  Infer,
  JsonValue,
  NativePluginContract,
  Schema,
} from "@bunaway/protocol";
/** App-wide JSON state for the lifetime of one Core instance. */
export interface StateStore {
  /** Returns a detached snapshot, or `undefined` when the key is absent. */
  get(key: string): JsonValue | undefined;
  /** Stores a validated copy so later caller mutations cannot change saved state. */
  set(key: string, value: JsonValue): void;
  /** Removes a key and reports whether it existed. */
  delete(key: string): boolean;
}

export type EventTarget =
  | {
      /** Delivers the event to every eligible subscribed view. */
      kind: "broadcast";
    }
  | {
      /** Delivers the event only to this view's eligible subscribers. */
      kind: "view";
      viewId: string;
    };
export interface EventEmitter {
  /** Emits a declared event after validation and delivers it to subscribers selected by `target`. */
  emit(event: string, payload: JsonValue, target: EventTarget): Promise<void>;
}

/** Execution context and cancellation signal supplied to commands and plugin setup. */
export type CommandContext = {
  /** Aborts when its command is cancelled or finishes, or when the backend stops. */
  readonly signal: CancellationSignal;
  /** Host operations bound to this execution context and its permissions. */
  readonly host: HostAPI;
  /** App-wide in-memory state shared by commands and plugins. */
  readonly state: StateStore;
  /** Validated event emission attributed to the command's view or the backend context. */
  readonly events: EventEmitter;
};

/** Runtime command contract consumed by Core after app registration. */
export type CommandDefinition<
  I extends Schema = Schema,
  O extends Schema = Schema,
> = {
  /** Schema used to validate the incoming payload before execution. */
  readonly input: I;
  /** Schema used to validate the value returned by `run`. */
  readonly output: O;
  /**
   * Executes one command with schema-validated input; Core validates the
   * returned value against the output schema.
   */
  run(payload: unknown, context: CommandContext): Promise<JsonValue>;
};
/** Named command definitions registered by an app or plugin. */
export type CommandRegistry = Readonly<Record<string, CommandDefinition>>;
/** Named event schemas registered by an app or plugin. */
export type EventRegistry = Readonly<Record<string, Schema>>;
/** Platform names accepted by plugin compatibility declarations. */
export type Platform = "windows" | "macos" | "linux" | "android" | "ios";
/** Plugin cleanup run during Core shutdown, in reverse setup order. */
export type StopHook = () => void | Promise<void>;
/** Plugin metadata and optional app registrations and lifecycle hooks. */
export type PluginDefinition = {
  /** Unique registration name used by dependencies and diagnostics. */
  readonly name: string;
  readonly version: string;
  /** Plugins that must be registered and initialized first. */
  readonly dependencies?: readonly string[];
  /** Platforms supported by this plugin; an incompatible app fails during Core creation. */
  readonly platforms?: readonly Platform[];
  /** Host permissions that must be declared by the backend policy. */
  readonly requiredPermissions?: readonly string[];
  /** Native operations and permission contracts exposed by this plugin. */
  readonly native?: NativePluginContract;
  /** Commands added to the app registry under their declared names. */
  readonly commands?: CommandRegistry;
  /** Event schemas added to the app registry under their declared names. */
  readonly events?: EventRegistry;
  /**
   * Initializes the plugin with the app's backend context. Return a hook to
   * release plugin-owned resources during shutdown; that hook runs after the
   * backend signal is aborted, so host calls from cleanup are cancelled.
   */
  setup?(
    context: CommandContext,
  ): void | StopHook | Promise<StopHook | undefined> | Promise<void>;
};

export type {
  DesktopContext,
  DesktopOptions,
  OpenRequest,
  QuitReason,
} from "./desktop.ts";

/** Complete app registration consumed by Core. */
export type AppDefinition = {
  /** App and plugin commands available to UI sessions. */
  readonly commands: CommandRegistry;
  /** Event schemas that commands and plugins may emit. */
  readonly events: EventRegistry;
  /** Initial app-wide JSON state. */
  readonly state?: Readonly<Record<string, JsonValue>>;
  /** Optional plugins whose registrations and setup hooks join this app. */
  readonly plugins?: readonly PluginDefinition[];
  /** Optional desktop-only window lifecycle configuration. */
  readonly desktop?: import("./desktop.ts").DesktopOptions;
};

/** Infers the input and output types of each registered app command. */
export type CommandsOf<A extends AppDefinition> = {
  [K in keyof A["commands"]]: {
    input: Infer<A["commands"][K]["input"]>;
    output: Infer<A["commands"][K]["output"]>;
  };
};
type PluginEvents<P> = P extends {
  readonly events: infer E extends EventRegistry;
}
  ? E
  : Record<never, never>;
type PluginEventEntries<P extends readonly PluginDefinition[]> =
  P extends readonly [
    infer First extends PluginDefinition,
    ...infer Rest extends readonly PluginDefinition[],
  ]
    ? PluginEvents<First> & PluginEventEntries<Rest>
    : Record<never, never>;
type AppEventEntries<A extends AppDefinition> = A["events"] &
  PluginEventEntries<NonNullable<A["plugins"]>>;
/** Infers app, module and statically registered plugin event payloads. */
export type EventsOf<A extends AppDefinition> = {
  [K in keyof AppEventEntries<A>]: Infer<AppEventEntries<A>[K]>;
};
