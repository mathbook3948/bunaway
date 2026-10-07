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
  onPluginError?(
    plugin: string,
    phase: "setup" | "stop",
    cause: unknown,
  ): void | Promise<void>;
  // The adapter closes the transport and bound session(s) on terminal send failure.
  send(context: HostContext, message: ServerMessage): Promise<void>;
  callHost(
    context: HostContext,
    call: HostCall,
    signal: CancellationSignal,
  ): Promise<HostResponse>;
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
export type CoreFactory = (
  app: AppDefinition,
  services: CoreServices,
) => Promise<Core>;

export { createCore } from "./create-core.ts";

export { bindHostAPI } from "./host-api.ts";
