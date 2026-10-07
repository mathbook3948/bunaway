import type {
  CancellationSignal,
  HostAPI,
  Infer,
  JsonValue,
  NativePluginContract,
  Schema,
} from "@bunaway/protocol";
export interface StateStore {
  get(key: string): JsonValue | undefined;
  set(key: string, value: JsonValue): void;
  delete(key: string): boolean;
}

export type EventTarget =
  | {
      kind: "broadcast";
    }
  | {
      kind: "view";
      viewId: string;
    };
export interface EventEmitter {
  emit(event: string, payload: JsonValue, target: EventTarget): Promise<void>;
}

export type CommandContext = {
  readonly signal: CancellationSignal;
  readonly host: HostAPI;
  readonly state: StateStore;
  readonly events: EventEmitter;
};

export type CommandDefinition<
  I extends Schema = Schema,
  O extends Schema = Schema,
> = {
  readonly input: I;
  readonly output: O;
  run(payload: unknown, context: CommandContext): Promise<JsonValue>;
};
export type CommandRegistry = Readonly<Record<string, CommandDefinition>>;
export type EventRegistry = Readonly<Record<string, Schema>>;
export type Platform = "windows" | "macos" | "linux" | "android" | "ios";
export type StopHook = () => void | Promise<void>;
export type PluginDefinition = {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: readonly string[];
  readonly platforms?: readonly Platform[];
  readonly requiredPermissions?: readonly string[];
  readonly native?: NativePluginContract;
  readonly commands?: CommandRegistry;
  readonly events?: EventRegistry;
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

export type AppDefinition = {
  readonly commands: CommandRegistry;
  readonly events: EventRegistry;
  readonly state?: Readonly<Record<string, JsonValue>>;
  readonly plugins?: readonly PluginDefinition[];
  readonly desktop?: import("./desktop.ts").DesktopOptions;
};

export type CommandsOf<A extends AppDefinition> = {
  [K in keyof A["commands"]]: {
    input: Infer<A["commands"][K]["input"]>;
    output: Infer<A["commands"][K]["output"]>;
  };
};
export type EventsOf<A extends AppDefinition> = {
  [K in keyof A["events"]]: Infer<A["events"][K]>;
};
