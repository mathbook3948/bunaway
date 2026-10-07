import type {
  CancellationController,
  CancellationSignal,
  ClientMessage,
  Dispose,
  Hello,
  HostAPI,
  HostCall,
  HostContext,
  HostResponse,
  Infer,
  JsonValue,
  NativePluginContract,
  Policy,
  Schema,
  ServerMessage,
  WireError,
} from "@bunaway/protocol";

export interface StateStore {
  get(key: string): JsonValue | undefined;
  set(key: string, value: JsonValue): void;
  delete(key: string): boolean;
}

export type EventTarget = { kind: "broadcast" } | { kind: "view"; viewId: string };
export interface EventEmitter {
  emit(event: string, payload: JsonValue, target: EventTarget): Promise<void>;
}

export type CommandContext = {
  readonly signal: CancellationSignal;
  readonly host: HostAPI;
  readonly state: StateStore;
  readonly events: EventEmitter;
};

export type CommandDefinition<I extends Schema = Schema, O extends Schema = Schema> = {
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
  setup?(context: CommandContext): void | StopHook | Promise<StopHook | undefined> | Promise<void>;
};

export type { DesktopContext, DesktopOptions, OpenRequest, QuitReason } from "./desktop.ts";

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
export type EventsOf<A extends AppDefinition> = { [K in keyof A["events"]]: Infer<A["events"][K]> };

// UTC at the wire boundary; schedule uses a monotonic clock in each runtime adapter.
export interface RuntimeServices {
  createCancellation(): CancellationController;
  now(): number;
  schedule(callback: () => void, delayMs: number): Dispose;
}

export type CoreServices = {
  readonly policy: Policy;
  readonly hello: Hello;
  readonly platform: Platform;
  readonly backendContext: HostContext;
  readonly runtime: RuntimeServices;
  // Trusted diagnostics only. Never include the cause in a WebView response.
  onCommandError?(command: string, cause: unknown): void | Promise<void>;
  onPluginError?(plugin: string, phase: "setup" | "stop", cause: unknown): void | Promise<void>;
  // The adapter closes the transport and bound session(s) on terminal send failure.
  send(context: HostContext, message: ServerMessage): Promise<void>;
  callHost(context: HostContext, call: HostCall, signal: CancellationSignal): Promise<HostResponse>;
};

export interface CoreSession {
  // Acceptance/dispatch completes here; terminal command results travel through services.send.
  receive(message: ClientMessage): Promise<void>;
  close(error?: WireError): Promise<void>;
}

export interface Core {
  // Only the host/runtime adapter opens sessions using host-issued IDs and selected policy views.
  openSession(context: HostContext, viewId: string): CoreSession;
  stop(): Promise<void>;
}

// Resolves after registration and plugin setup; runtime ready must wait for this.
export type CoreFactory = (app: AppDefinition, services: CoreServices) => Promise<Core>;

export { createCore } from "./create-core.ts";

export { bindHostAPI } from "./host-api.ts";
