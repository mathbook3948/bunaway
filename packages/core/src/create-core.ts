import {
  API_LIMITS,
  BunawayError,
  type CancellationController,
  type CancellationSignal,
  type ClientMessage,
  type Dispose,
  type Hello,
  type HostContext,
  type JsonValue,
  type NativeRegistry,
  negotiateProtocol,
  type Policy,
  ProtocolError,
  type Schema,
  type ServerMessage,
  serializeMessage,
  validateValue,
  type WireError,
} from "@bunaway/protocol";
import {
  type PreparedAppRegistry,
  prepareAppRegistry,
} from "./app-registry.ts";
import { bindHostAPI } from "./host-api.ts";
import type {
  CommandContext,
  CommandDefinition,
  Core,
  CoreFactory,
  CoreServices,
  CoreSession,
  EventTarget,
  StateStore,
  StopHook,
} from "./index.ts";

type ViewPolicy = Policy["views"][number];

function fail(code: WireError["code"], message: string): never {
  throw new BunawayError({
    code,
    message,
  });
}

function reportDiagnostic(
  report: () => void | Promise<void> | undefined,
): void {
  try {
    void Promise.resolve(report()).catch(() => {});
  } catch {
    // Diagnostics must not replace the original failure or block cleanup.
  }
}

// The store keeps validated snapshots; reads and writes both copy so callers
// can never mutate retained state.
function createStateStore(
  initial: Readonly<Record<string, JsonValue>> | undefined,
): StateStore {
  const data = new Map<string, JsonValue>();
  for (const [key, value] of Object.entries(initial ?? {})) {
    data.set(key, validateValue({}, value));
  }
  return {
    get: (key) => {
      const value = data.get(key);
      return value === undefined ? undefined : validateValue({}, value);
    },
    set: (key, value) => {
      data.set(key, validateValue({}, value));
    },
    delete: (key) => data.delete(key),
  };
}

function toWireError(cause: unknown): WireError {
  if (cause instanceof BunawayError) {
    return cause.details === undefined
      ? {
          code: cause.code,
          message: cause.message,
        }
      : {
          code: cause.code,
          message: cause.message,
          details: cause.details,
        };
  }
  return {
    code: "INTERNAL",
    message: "Command failed.",
  };
}

type PendingRequest = {
  id: string;
  controller: CancellationController;
  timer: Dispose | null;
  done: boolean;
};

type Subscription = {
  id: string;
  event: string;
  sequence: number;
  queued: number;
  dead: boolean;
  // Sends serialize through this chain; the listen result is its first step so
  // no event can overtake the subscription response.
  chain: Promise<void>;
};

type EventDelivery = {
  subscription: Subscription;
  message: Extract<
    ServerMessage,
    {
      kind: "event";
    }
  >;
};

class SessionImpl implements CoreSession {
  helloDone = false;
  closed = false;
  failed = false;
  private outProtocol: Hello["protocol"];
  private readonly requestIds = new Set<string>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly subscriptions = new Map<string, Subscription>();
  private subscriptionCounter = 0;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly core: BunawayCore,
    readonly context: HostContext,
    readonly view: ViewPolicy,
  ) {
    this.outProtocol = core.services.hello.protocol;
  }

  async receive(message: ClientMessage): Promise<void> {
    if (this.closed) {
      return;
    }
    switch (message.kind) {
      case "close":
        await this.close();
        return;
      case "hello":
        await this.handleHello(message);
        return;
      case "invoke":
        this.handleInvoke(message);
        return;
      case "cancel":
        this.handleCancel(message);
        return;
      case "listen":
        this.handleListen(message);
        return;
      case "unlisten":
        this.handleUnlisten(message);
        return;
    }
  }

  close(error?: WireError): Promise<void> {
    this.closePromise ??= this.doClose(error);
    return this.closePromise;
  }

  private async doClose(error?: WireError): Promise<void> {
    this.closed = true;
    const failure = error ?? {
      code: "CANCELLED" as const,
      message: "Session closed.",
    };
    const replies: Promise<void>[] = [];
    for (const pending of this.pending.values()) {
      pending.controller.abort();
      replies.push(
        this.settle(pending, {
          kind: "error",
          protocol: this.outProtocol,
          id: pending.id,
          error: failure,
        }),
      );
    }
    for (const subscription of this.subscriptions.values()) {
      subscription.dead = true;
    }
    this.subscriptions.clear();
    await Promise.all(replies);
    this.core.releaseSession(this);
  }

  private async handleHello(message: Hello): Promise<void> {
    if (this.helloDone) {
      await this.close({
        code: "INVALID_ARGUMENT",
        message: "Duplicate hello.",
      });
      return;
    }
    try {
      const negotiated = negotiateProtocol(this.core.services.hello, message);
      this.outProtocol = negotiated.protocol;
    } catch (cause) {
      const code =
        cause instanceof ProtocolError ? cause.code : "INVALID_ARGUMENT";
      await this.close({
        code,
        message: "Protocol negotiation failed.",
      });
      // The SDK must receive our hello to reject an incompatible major version
      // immediately; silently closing only the core session leaves ready pending.
      if (code === "UNSUPPORTED") {
        await this.sendOrFail(this.core.services.hello);
      }
      return;
    }
    this.helloDone = true;
    await this.sendOrFail(this.core.services.hello);
  }

  // A failed send means the transport path is broken: stop emitting and let the
  // adapter-driven close (also triggered here) tear the session down.
  private async sendOrFail(message: ServerMessage): Promise<void> {
    if (this.failed) {
      return;
    }
    try {
      await this.core.services.send(this.context, message);
    } catch {
      this.failed = true;
      void this.close();
    }
  }

  private respondError(id: string, error: WireError): void {
    void this.sendOrFail({
      kind: "error",
      protocol: this.outProtocol,
      id,
      error,
    });
  }

  // Every request ID is recorded once for the session lifetime, whether the
  // request is executed, rejected, cancelled, or expired.
  private acceptRequest(id: string): boolean {
    if (this.closed || this.failed) {
      return false;
    }
    // A duplicate is not a new request and must not settle the original again.
    if (this.requestIds.has(id)) {
      return false;
    }
    if (this.requestIds.size >= API_LIMITS.maxRequestIds) {
      this.respondError(id, {
        code: "BUSY",
        message: "Request limit reached.",
      });
      return false;
    }
    this.requestIds.add(id);
    if (!this.helloDone) {
      this.respondError(id, {
        code: "INVALID_ARGUMENT",
        message: "Protocol handshake required.",
      });
      return false;
    }
    return true;
  }

  private handleInvoke(
    message: Extract<
      ClientMessage,
      {
        kind: "invoke";
      }
    >,
  ): void {
    if (!this.acceptRequest(message.id)) {
      return;
    }
    if (this.pending.size >= API_LIMITS.maxPending) {
      this.respondError(message.id, {
        code: "BUSY",
        message: "Pending request limit reached.",
      });
      return;
    }
    if (
      message.command.startsWith("plugin.") &&
      !this.view.commands.includes(message.command)
    ) {
      this.respondError(message.id, {
        code: "PERMISSION_DENIED",
        message: "Command not allowed.",
      });
      return;
    }
    const definition = this.core.commands.get(message.command);
    if (!definition) {
      const unknownPlugin =
        message.command.startsWith("plugin.") &&
        !this.core.registry.plugins.has(message.command.split(".")[1] ?? "");
      this.respondError(message.id, {
        code: unknownPlugin ? "UNSUPPORTED" : "INVALID_ARGUMENT",
        message: "Unknown command.",
      });
      return;
    }
    if (!this.view.commands.includes(message.command)) {
      this.respondError(message.id, {
        code: "PERMISSION_DENIED",
        message: "Command not allowed.",
      });
      return;
    }
    const now = this.core.services.runtime.now();
    let remaining: number = API_LIMITS.maxCommandDurationMs;
    if (message.deadline !== undefined) {
      if (message.deadline <= now) {
        this.respondError(message.id, {
          code: "TIMEOUT",
          message: "Command deadline expired.",
        });
        return;
      }
      remaining = Math.min(message.deadline - now, remaining);
    }
    const controller = this.core.services.runtime.createCancellation();
    const pending: PendingRequest = {
      id: message.id,
      controller,
      timer: null,
      done: false,
    };
    pending.timer = this.core.services.runtime.schedule(() => {
      controller.abort();
      void this.settle(pending, {
        kind: "error",
        protocol: this.outProtocol,
        id: pending.id,
        error: {
          code: "TIMEOUT",
          message: "Command timed out.",
        },
      });
    }, remaining);
    this.pending.set(message.id, pending);
    void this.execute(pending, definition, message.payload, message.command);
  }

  // Runs detached from receive() so a slow handler never blocks acceptance of
  // later messages. Exactly one settle() wins; late results are discarded.
  private async execute(
    pending: PendingRequest,
    definition: CommandDefinition,
    payload: JsonValue,
    command: string,
  ): Promise<void> {
    let reply: ServerMessage;
    try {
      let input: JsonValue;
      try {
        input = validateValue(definition.input, payload);
      } catch {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Invalid command input.",
        });
      }
      const result = await definition.run(
        input,
        this.makeContext(pending.controller.signal),
      );
      let output: JsonValue;
      try {
        output = validateValue(definition.output, result);
        reply = {
          kind: "result",
          protocol: this.outProtocol,
          id: pending.id,
          payload: output,
        };
        // Include protocol and correlation fields before handing the reply to a transport.
        serializeMessage(reply);
      } catch {
        throw new BunawayError({
          code: "INTERNAL",
          message: "Invalid command output.",
        });
      }
    } catch (cause) {
      if (!(cause instanceof BunawayError)) {
        reportDiagnostic(() =>
          this.core.services.onCommandError?.(command, cause),
        );
      }
      reply = {
        kind: "error",
        protocol: this.outProtocol,
        id: pending.id,
        error: toWireError(cause),
      };
    }
    await this.settle(pending, reply);
  }

  private makeContext(signal: CancellationSignal): CommandContext {
    return {
      signal,
      host: bindHostAPI(
        this.context,
        signal,
        this.core.services.callHost,
        this.core.registry,
      ),
      state: this.core.state,
      events: {
        emit: async (event, payload, target) => {
          if (signal.aborted || this.closed || this.failed) {
            fail("CANCELLED", "Event emission cancelled.");
          }
          await this.core.emit(event, payload, target, this.view.id);
        },
      },
    };
  }

  private async settle(
    pending: PendingRequest,
    reply: ServerMessage,
  ): Promise<void> {
    if (pending.done) {
      return;
    }
    pending.done = true;
    this.pending.delete(pending.id);
    pending.timer?.();
    pending.controller.abort();
    await this.sendOrFail(reply);
  }

  private handleCancel(
    message: Extract<
      ClientMessage,
      {
        kind: "cancel";
      }
    >,
  ): void {
    const pending = this.pending.get(message.id);
    if (!pending || pending.done) {
      return;
    }
    pending.controller.abort();
    void this.settle(pending, {
      kind: "error",
      protocol: this.outProtocol,
      id: pending.id,
      error: {
        code: "CANCELLED",
        message: "Request cancelled.",
      },
    });
  }

  private handleListen(
    message: Extract<
      ClientMessage,
      {
        kind: "listen";
      }
    >,
  ): void {
    if (!this.acceptRequest(message.id)) {
      return;
    }
    if (!this.core.events.has(message.event)) {
      this.respondError(message.id, {
        code: "INVALID_ARGUMENT",
        message: "Unknown event.",
      });
      return;
    }
    if (!this.view.events.includes(message.event)) {
      this.respondError(message.id, {
        code: "PERMISSION_DENIED",
        message: "Event not allowed.",
      });
      return;
    }
    if (this.subscriptions.size >= API_LIMITS.maxSubscriptions) {
      this.respondError(message.id, {
        code: "BUSY",
        message: "Subscription limit reached.",
      });
      return;
    }
    const subscription: Subscription = {
      id: `sub-${++this.subscriptionCounter}`,
      event: message.event,
      sequence: 0,
      queued: 0,
      dead: false,
      chain: Promise.resolve(),
    };
    this.subscriptions.set(subscription.id, subscription);
    subscription.chain = this.sendOrFail({
      kind: "result",
      protocol: this.outProtocol,
      id: message.id,
      payload: {
        subscriptionId: subscription.id,
      },
    });
  }

  private handleUnlisten(
    message: Extract<
      ClientMessage,
      {
        kind: "unlisten";
      }
    >,
  ): void {
    if (!this.acceptRequest(message.id)) {
      return;
    }
    const subscription = this.subscriptions.get(message.subscriptionId);
    if (!subscription) {
      this.respondError(message.id, {
        code: "INVALID_ARGUMENT",
        message: "Unknown subscription.",
      });
      return;
    }
    subscription.dead = true;
    this.subscriptions.delete(subscription.id);
    void this.sendOrFail({
      kind: "result",
      protocol: this.outProtocol,
      id: message.id,
      payload: null,
    });
  }

  prepareEvent(
    event: string,
    source: string,
    payload: JsonValue,
  ): EventDelivery[] {
    const deliveries: EventDelivery[] = [];
    for (const subscription of this.subscriptions.values()) {
      if (subscription.event !== event || subscription.dead) {
        continue;
      }
      const message: EventDelivery["message"] = {
        kind: "event",
        protocol: this.outProtocol,
        subscriptionId: subscription.id,
        source,
        target: this.view.id,
        event,
        sequence: subscription.sequence + 1,
        payload,
      };
      serializeMessage(message);
      this.core.services.validateMessage?.(this.context, message);
      deliveries.push({
        subscription,
        message,
      });
    }
    return deliveries;
  }

  deliver(deliveries: readonly EventDelivery[]): void {
    for (const { subscription, message } of deliveries) {
      subscription.sequence = message.sequence;
      this.enqueueEvent(subscription, message);
    }
  }

  private enqueueEvent(
    subscription: Subscription,
    message: ServerMessage,
  ): void {
    if (subscription.dead) {
      return;
    }
    if (subscription.queued >= API_LIMITS.maxPending) {
      this.terminateSubscription(subscription, {
        code: "BUSY",
        message: "Subscription queue full.",
      });
      return;
    }
    subscription.queued += 1;
    subscription.chain = subscription.chain.then(async () => {
      subscription.queued -= 1;
      if (subscription.dead) {
        return;
      }
      await this.sendOrFail(message);
    });
  }

  // The terminal subscription-error rides the same chain so it is the last
  // message the subscription can produce.
  private terminateSubscription(
    subscription: Subscription,
    error: WireError,
  ): void {
    if (subscription.dead) {
      return;
    }
    subscription.dead = true;
    this.subscriptions.delete(subscription.id);
    subscription.chain = subscription.chain.then(() => {
      if (this.closed) {
        return;
      }
      return this.sendOrFail({
        kind: "subscription-error",
        protocol: this.outProtocol,
        subscriptionId: subscription.id,
        error,
      });
    });
  }
}

class BunawayCore implements Core {
  readonly sessions = new Map<HostContext, SessionImpl>();
  readonly registry: NativeRegistry;
  readonly commands: ReadonlyMap<string, CommandDefinition>;
  readonly events: ReadonlyMap<string, Schema>;
  private readonly views: ReadonlyMap<string, Policy["views"][number]>;
  private stopped = false;
  private readonly stopHooks: {
    plugin: string;
    stop: StopHook;
  }[] = [];
  private stopPromise: Promise<void> | null = null;
  private readonly backendController: CancellationController;

  constructor(
    readonly services: CoreServices,
    prepared: PreparedAppRegistry,
    readonly state: StateStore,
  ) {
    this.registry = prepared.registry;
    this.commands = prepared.commands;
    this.events = prepared.events;
    this.views = prepared.views;
    this.backendController = services.runtime.createCancellation();
  }

  openSession(context: HostContext, viewId: string): CoreSession {
    const view = this.views.get(viewId);
    if (!view) {
      fail("INVALID_ARGUMENT", `Unknown view "${viewId}".`);
    }
    if (this.stopped) {
      fail("INVALID_ARGUMENT", "Core is stopped.");
    }
    if (this.sessions.has(context)) {
      fail("INVALID_ARGUMENT", `Duplicate context "${context}".`);
    }
    const session = new SessionImpl(this, context, view);
    this.sessions.set(context, session);
    return session;
  }

  releaseSession(session: SessionImpl): void {
    if (this.sessions.get(session.context) === session) {
      this.sessions.delete(session.context);
    }
  }

  // The emitting context decides the public source: a view session reports its
  // view ID, backend/plugin work reports "backend". Web requests are never
  // promoted to the backend source.
  async emit(
    event: string,
    payload: JsonValue,
    target: EventTarget,
    source: string,
  ): Promise<void> {
    const schema = this.events.get(event);
    if (!schema) {
      fail("INVALID_ARGUMENT", `Undeclared event "${event}".`);
    }
    let data: JsonValue;
    try {
      data = validateValue(schema, payload);
    } catch {
      fail("INVALID_ARGUMENT", "Invalid event payload.");
    }
    if (target.kind === "view" && !this.views.has(target.viewId)) {
      fail("INVALID_ARGUMENT", `Unknown view "${target.viewId}".`);
    }
    const deliveries: {
      session: SessionImpl;
      events: EventDelivery[];
    }[] = [];
    try {
      for (const session of this.sessions.values()) {
        if (session.closed || session.failed || !session.helloDone) {
          continue;
        }
        if (target.kind === "view" && session.view.id !== target.viewId) {
          continue;
        }
        if (!session.view.events.includes(event)) {
          continue;
        }
        deliveries.push({
          session,
          events: session.prepareEvent(event, source, data),
        });
      }
    } catch {
      fail("INVALID_ARGUMENT", "Invalid event message.");
    }
    // Validate every destination before mutating queues or sequence counters so
    // an invalid event cannot reach only some of its subscriptions.
    for (const { session, events } of deliveries) {
      session.deliver(events);
    }
  }

  makeBackendContext(): CommandContext {
    const signal = this.backendController.signal;
    return {
      signal,
      host: bindHostAPI(
        this.services.backendContext,
        signal,
        this.services.callHost,
        this.registry,
      ),
      state: this.state,
      events: {
        emit: async (event, payload, target) => {
          if (signal.aborted) {
            fail("CANCELLED", "Event emission cancelled.");
          }
          await this.emit(event, payload, target, "backend");
        },
      },
    };
  }

  addStopHook(plugin: string, stop: StopHook): void {
    this.stopHooks.push({
      plugin,
      stop,
    });
  }

  // Stop hooks best-effort in reverse setup order; individual failures never
  // skip later hooks.
  async cleanupPlugins(): Promise<void> {
    for (const { plugin, stop } of [
      ...this.stopHooks,
    ].reverse()) {
      try {
        await stop();
      } catch (cause) {
        reportDiagnostic(() =>
          this.services.onPluginError?.(plugin, "stop", cause),
        );
      }
    }
    this.stopHooks.length = 0;
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.doStop();
    return this.stopPromise;
  }

  private async doStop(): Promise<void> {
    this.stopped = true;
    this.backendController.abort();
    const cleanup = (async () => {
      const sessions = [
        ...this.sessions.values(),
      ];
      await Promise.all(sessions.map((session) => session.close()));
      await this.cleanupPlugins();
    })();
    const guard: {
      timer: Dispose | null;
    } = {
      timer: null,
    };
    const deadline = new Promise<never>((_, reject) => {
      guard.timer = this.services.runtime.schedule(
        () =>
          reject(
            new BunawayError({
              code: "TIMEOUT",
              message: "Core shutdown timed out.",
            }),
          ),
        API_LIMITS.shutdownTimeoutMs,
      );
    });
    try {
      await Promise.race([
        cleanup,
        deadline,
      ]);
    } finally {
      guard.timer?.();
    }
  }
}

export const createCore: CoreFactory = async (app, services) => {
  const appRegistry = prepareAppRegistry(app, services);
  const core = new BunawayCore(
    services,
    appRegistry,
    createStateStore(app.state),
  );
  try {
    for (const plugin of appRegistry.plugins) {
      try {
        const hook = await plugin.setup?.(core.makeBackendContext());
        if (typeof hook === "function") {
          core.addStopHook(plugin.name, hook);
        }
      } catch (cause) {
        reportDiagnostic(() =>
          services.onPluginError?.(plugin.name, "setup", cause),
        );
        throw cause;
      }
    }
  } catch (cause) {
    await core.stop();
    if (cause instanceof BunawayError) {
      throw cause;
    }
    throw new BunawayError({
      code: "INTERNAL",
      message: "Plugin setup failed.",
    });
  }
  return core;
};
