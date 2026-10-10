import type {
  CancellationController,
  CancellationSignal,
  ClientMessage,
  Dispose,
  Hello,
  HostCall,
  HostContext,
  HostResponse,
  Policy,
  ServerMessage,
  WireError,
} from "@bunaway/protocol";

export type {
  AppDefinition,
  CommandContext,
  CommandDefinition,
  CommandRegistry,
  CommandsOf,
  DesktopContext,
  DesktopOptions,
  EventEmitter,
  EventRegistry,
  EventsOf,
  EventTarget,
  OpenRequest,
  Platform,
  PluginDefinition,
  QuitReason,
  StateStore,
  StopHook,
} from "@bunaway/plugin-api";

import type { AppDefinition, Platform } from "@bunaway/plugin-api";

/** Clock, timer, and cancellation primitives supplied by the host runtime. */
export interface RuntimeServices {
  createCancellation(): CancellationController;
  /** Returns Unix epoch milliseconds for comparing command deadlines. */
  now(): number;
  /** Schedules a callback after a delay and returns a function that cancels it. */
  schedule(callback: () => void, delayMs: number): Dispose;
}

/** Host and runtime capabilities used to validate and run an app core. */
export type CoreServices = {
  readonly policy: Policy;
  readonly hello: Hello;
  readonly platform: Platform;
  readonly backendContext: HostContext;
  readonly runtime: RuntimeServices;
  /** Reports unexpected command causes; views receive generic INTERNAL errors for them. */
  onCommandError?(command: string, cause: unknown): void | Promise<void>;
  /** Reports plugin setup and stop failures without interrupting cleanup. */
  onPluginError?(
    plugin: string,
    phase: "setup" | "stop",
    cause: unknown,
  ): void | Promise<void>;
  /**
   * Checks adapter-specific envelope limits without sending or changing queues.
   * Event emission validates all destinations before delivering to any of them.
   */
  validateMessage?(context: HostContext, message: ServerMessage): void;
  /**
   * Sends a message through the transport for this context. A rejection fails
   * the owning Core session.
   */
  send(context: HostContext, message: ServerMessage): Promise<void>;
  /** Runs a host operation with cancellation from the owning command or backend context. */
  callHost(
    context: HostContext,
    call: HostCall,
    signal: CancellationSignal,
  ): Promise<HostResponse>;
};

/** One host-bound protocol session and the requests and subscriptions it owns. */
export interface CoreSession {
  /** Resolves after accepting a message for dispatch; command results use CoreServices.send. */
  receive(message: ClientMessage): Promise<void>;
  /** Idempotently cancels pending work, removes subscriptions, and releases the context. */
  close(error?: WireError): Promise<void>;
}

/** App core that owns registered handlers, shared state, sessions, and plugins. */
export interface Core {
  /**
   * Opens a session for a host-issued context and allowed policy view.
   * Fails for an unknown view, a stopped core, or a context already in use.
   */
  openSession(context: HostContext, viewId: string): CoreSession;
  /** Sends a host-observed event only to this live context, validating its schema and view policy. Stale contexts are ignored. */
  emitNative(
    context: HostContext,
    event: string,
    payload: import("@bunaway/protocol").JsonValue,
  ): Promise<void>;
  /** Closes sessions and stops plugins, rejecting if shutdown exceeds its deadline. */
  stop(): Promise<void>;
}

/**
 * Creates an app core and resolves after registration and plugin setup complete.
 * Runtimes should wait for this promise before reporting the app as ready.
 */
export type CoreFactory = (
  app: AppDefinition,
  services: CoreServices,
) => Promise<Core>;

export { createCore } from "./create-core.ts";

export { bindHostAPI } from "./host-api.ts";
