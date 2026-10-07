import {
  API_LIMITS,
  BunawayError,
  CAPABILITIES_COMMAND,
  type CancellationController,
  type CancellationSignal,
  type ClientMessage,
  type Dispose,
  type Hello,
  type HostAPI,
  type HostCall,
  type HostContext,
  type HostResponse,
  hostCallSchema,
  hostOperations,
  hostResponseSchema,
  type JsonValue,
  negotiateProtocol,
  type Policy,
  ProtocolError,
  type Schema,
  type ServerMessage,
  validateHostOutput,
  validateValue,
  type WireError,
} from "@bunaway/protocol";
import type {
  CommandContext,
  CommandDefinition,
  Core,
  CoreFactory,
  CoreServices,
  CoreSession,
  EventTarget,
  PluginDefinition,
  StateStore,
  StopHook,
} from "./index.ts";

type ViewPolicy = Policy["views"][number];
type HostPermissions = Policy["backend"];

const NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

function fail(code: WireError["code"], message: string): never {
  throw new BunawayError({ code, message });
}

function checkRegistrationName(name: string, kind: "command" | "event", owner: string): void {
  if (!NAME_PATTERN.test(name))
    fail("INVALID_ARGUMENT", `${owner} registered an invalid ${kind} name.`);
  if (kind === "command" && name === CAPABILITIES_COMMAND)
    fail(
      "INVALID_ARGUMENT",
      `${owner} cannot register the reserved ${CAPABILITIES_COMMAND} command.`,
    );
}

function registerAll<T>(
  target: Map<string, T>,
  entries: Readonly<Record<string, T>>,
  kind: "command" | "event",
  owner: string,
): void {
  for (const [name, definition] of Object.entries(entries)) {
    checkRegistrationName(name, kind, owner);
    if (target.has(name)) fail("INVALID_ARGUMENT", `Duplicate ${kind} "${name}".`);
    target.set(name, definition);
  }
}

// A policy entry covers a required prefix when it grants the same or a wider scope subtree.
function coversPathPrefix(granted: string, required: string): boolean {
  return granted === "" || granted === required || required.startsWith(`${granted}/`);
}

function coversHostPermissions(granted: HostPermissions, required: HostPermissions): boolean {
  if (required.log && !granted.log) return false;
  if ((required.windows ?? []).some((view) => !granted.windows?.includes(view))) return false;
  return required.storage.every((need) =>
    need.access.every((access) =>
      granted.storage.some(
        (have) =>
          have.scope === need.scope &&
          coversPathPrefix(have.pathPrefix, need.pathPrefix) &&
          have.access.includes(access),
      ),
    ),
  );
}

function orderPlugins(plugins: readonly PluginDefinition[], services: CoreServices) {
  const byName = new Map<string, PluginDefinition>();
  for (const plugin of plugins) {
    if (byName.has(plugin.name)) fail("INVALID_ARGUMENT", `Duplicate plugin "${plugin.name}".`);
    byName.set(plugin.name, plugin);
  }
  const ordered: PluginDefinition[] = [];
  const marks = new Map<string, "open" | "done">();
  const visit = (plugin: PluginDefinition): void => {
    const mark = marks.get(plugin.name);
    if (mark === "done") return;
    if (mark === "open") fail("INVALID_ARGUMENT", `Plugin dependency cycle at "${plugin.name}".`);
    marks.set(plugin.name, "open");
    for (const dependency of plugin.dependencies ?? []) {
      const target = byName.get(dependency);
      if (!target)
        fail(
          "INVALID_ARGUMENT",
          `Plugin "${plugin.name}" requires unknown plugin "${dependency}".`,
        );
      visit(target);
    }
    marks.set(plugin.name, "done");
    ordered.push(plugin);
  };
  for (const plugin of plugins) visit(plugin);
  for (const plugin of ordered) {
    if (plugin.platforms && !plugin.platforms.includes(services.platform))
      fail("UNSUPPORTED", `Plugin "${plugin.name}" does not support ${services.platform}.`);
    if (plugin.requiredHost && !coversHostPermissions(services.policy.backend, plugin.requiredHost))
      fail(
        "INVALID_ARGUMENT",
        `Plugin "${plugin.name}" requires host permissions outside the backend policy.`,
      );
  }
  return ordered;
}

// The store keeps validated snapshots; reads and writes both copy so callers
// can never mutate retained state.
function createStateStore(initial: Readonly<Record<string, JsonValue>> | undefined): StateStore {
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

// Same binding semantics as the runtime adapter: the context is fixed, calls
// are checked before and after the operation, and cancellation wins promptly.
function createHostAPI(
  context: HostContext,
  signal: CancellationSignal,
  callHost: CoreServices["callHost"],
): HostAPI {
  const checkCancelled = () => {
    if (signal.aborted)
      throw new BunawayError({ code: "CANCELLED", message: "Host operation cancelled." });
  };
  return {
    async call(operation, payload) {
      checkCancelled();
      let call: HostCall;
      try {
        call = validateValue(hostCallSchema, { operation, payload }) as HostCall;
      } catch {
        throw new BunawayError({ code: "INVALID_ARGUMENT", message: "Invalid host request." });
      }
      let response: HostResponse;
      let onAbort = () => {};
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () =>
          reject(new BunawayError({ code: "CANCELLED", message: "Host operation cancelled." }));
        signal.addEventListener("abort", onAbort);
      });
      try {
        response = validateValue(
          hostResponseSchema,
          await Promise.race([
            Promise.resolve().then(() => {
              checkCancelled();
              return callHost(context, call, signal);
            }),
            aborted,
          ]),
        );
      } catch (cause) {
        checkCancelled();
        if (cause instanceof BunawayError) throw cause;
        throw new BunawayError({ code: "INTERNAL", message: "Host operation failed." });
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
      checkCancelled();
      if (response.kind === "error") throw new BunawayError(response.error);
      try {
        return validateHostOutput(operation, response.payload);
      } catch {
        throw new BunawayError({ code: "INTERNAL", message: "Invalid host response." });
      }
    },
  };
}

const capabilitiesCommand: CommandDefinition = {
  input: { const: null },
  output: hostOperations["capabilities.get"].output,
  async run(_payload, context) {
    return (await context.host.call("capabilities.get", null)) as JsonValue;
  },
};

function toWireError(cause: unknown): WireError {
  if (cause instanceof BunawayError) {
    return cause.details === undefined
      ? { code: cause.code, message: cause.message }
      : { code: cause.code, message: cause.message, details: cause.details };
  }
  return { code: "INTERNAL", message: "Command failed." };
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
    if (this.closed) return;
    switch (message.kind) {
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
    const failure = error ?? { code: "CANCELLED" as const, message: "Session closed." };
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
    for (const subscription of this.subscriptions.values()) subscription.dead = true;
    this.subscriptions.clear();
    await Promise.all(replies);
    this.core.releaseSession(this);
  }

  private async handleHello(message: Hello): Promise<void> {
    if (this.helloDone) {
      await this.close({ code: "INVALID_ARGUMENT", message: "Duplicate hello." });
      return;
    }
    try {
      const negotiated = negotiateProtocol(this.core.services.hello, message);
      this.outProtocol = negotiated.protocol;
    } catch (cause) {
      const code = cause instanceof ProtocolError ? cause.code : "INVALID_ARGUMENT";
      await this.close({ code, message: "Protocol negotiation failed." });
      // The SDK must receive our hello to reject an incompatible major version
      // immediately; silently closing only the core session leaves ready pending.
      if (code === "UNSUPPORTED") await this.sendOrFail(this.core.services.hello);
      return;
    }
    this.helloDone = true;
    await this.sendOrFail(this.core.services.hello);
  }

  // A failed send means the transport path is broken: stop emitting and let the
  // adapter-driven close (also triggered here) tear the session down.
  private async sendOrFail(message: ServerMessage): Promise<void> {
    if (this.failed) return;
    try {
      await this.core.services.send(this.context, message);
    } catch {
      this.failed = true;
      void this.close();
    }
  }

  private respondError(id: string, error: WireError): void {
    void this.sendOrFail({ kind: "error", protocol: this.outProtocol, id, error });
  }

  // Every request ID is recorded once for the session lifetime, whether the
  // request is executed, rejected, cancelled, or expired.
  private acceptRequest(id: string): boolean {
    if (this.closed || this.failed) return false;
    // A duplicate is not a new request and must not settle the original again.
    if (this.requestIds.has(id)) return false;
    if (this.requestIds.size >= API_LIMITS.maxRequestIds) {
      this.respondError(id, { code: "BUSY", message: "Request limit reached." });
      return false;
    }
    this.requestIds.add(id);
    if (!this.helloDone) {
      this.respondError(id, { code: "INVALID_ARGUMENT", message: "Protocol handshake required." });
      return false;
    }
    return true;
  }

  private handleInvoke(message: Extract<ClientMessage, { kind: "invoke" }>): void {
    if (!this.acceptRequest(message.id)) return;
    if (this.pending.size >= API_LIMITS.maxPending) {
      this.respondError(message.id, {
        code: "BUSY",
        message: "Pending request limit reached.",
      });
      return;
    }
    const definition = this.core.commands.get(message.command);
    if (!definition) {
      this.respondError(message.id, {
        code: "INVALID_ARGUMENT",
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
        error: { code: "TIMEOUT", message: "Command timed out." },
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
        throw new BunawayError({ code: "INVALID_ARGUMENT", message: "Invalid command input." });
      }
      const result = await definition.run(input, this.makeContext(pending.controller.signal));
      let output: JsonValue;
      try {
        output = validateValue(definition.output, result);
      } catch {
        throw new BunawayError({ code: "INTERNAL", message: "Invalid command output." });
      }
      reply = { kind: "result", protocol: this.outProtocol, id: pending.id, payload: output };
    } catch (cause) {
      if (!(cause instanceof BunawayError)) {
        try {
          void Promise.resolve(this.core.services.onCommandError?.(command, cause)).catch(() => {});
        } catch {
          // Diagnostic failures must not replace or delay the command response.
        }
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
      host: createHostAPI(this.context, signal, this.core.services.callHost),
      state: this.core.state,
      events: {
        emit: async (event, payload, target) => {
          if (signal.aborted || this.closed || this.failed)
            fail("CANCELLED", "Event emission cancelled.");
          await this.core.emit(event, payload, target, this.view.id);
        },
      },
    };
  }

  private async settle(pending: PendingRequest, reply: ServerMessage): Promise<void> {
    if (pending.done) return;
    pending.done = true;
    this.pending.delete(pending.id);
    pending.timer?.();
    pending.controller.abort();
    await this.sendOrFail(reply);
  }

  private handleCancel(message: Extract<ClientMessage, { kind: "cancel" }>): void {
    const pending = this.pending.get(message.id);
    if (!pending || pending.done) return;
    pending.controller.abort();
    void this.settle(pending, {
      kind: "error",
      protocol: this.outProtocol,
      id: pending.id,
      error: { code: "CANCELLED", message: "Request cancelled." },
    });
  }

  private handleListen(message: Extract<ClientMessage, { kind: "listen" }>): void {
    if (!this.acceptRequest(message.id)) return;
    if (!this.core.events.has(message.event)) {
      this.respondError(message.id, { code: "INVALID_ARGUMENT", message: "Unknown event." });
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
      payload: { subscriptionId: subscription.id },
    });
  }

  private handleUnlisten(message: Extract<ClientMessage, { kind: "unlisten" }>): void {
    if (!this.acceptRequest(message.id)) return;
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

  deliver(event: string, source: string, payload: JsonValue): void {
    for (const subscription of this.subscriptions.values()) {
      if (subscription.event !== event || subscription.dead) continue;
      this.enqueueEvent(subscription, {
        kind: "event",
        protocol: this.outProtocol,
        subscriptionId: subscription.id,
        source,
        target: this.view.id,
        event,
        sequence: ++subscription.sequence,
        payload,
      });
    }
  }

  private enqueueEvent(subscription: Subscription, message: ServerMessage): void {
    if (subscription.dead) return;
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
      if (subscription.dead) return;
      await this.sendOrFail(message);
    });
  }

  // The terminal subscription-error rides the same chain so it is the last
  // message the subscription can produce.
  private terminateSubscription(subscription: Subscription, error: WireError): void {
    if (subscription.dead) return;
    subscription.dead = true;
    this.subscriptions.delete(subscription.id);
    subscription.chain = subscription.chain.then(() => {
      if (this.closed) return;
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
  private stopped = false;
  private readonly stopHooks: StopHook[] = [];
  private stopPromise: Promise<void> | null = null;
  private readonly backendController: CancellationController;

  constructor(
    readonly services: CoreServices,
    readonly commands: Map<string, CommandDefinition>,
    readonly events: Map<string, Schema>,
    readonly state: StateStore,
    private readonly views: Map<string, ViewPolicy>,
  ) {
    this.backendController = services.runtime.createCancellation();
  }

  openSession(context: HostContext, viewId: string): CoreSession {
    const view = this.views.get(viewId);
    if (!view) fail("INVALID_ARGUMENT", `Unknown view "${viewId}".`);
    if (this.stopped) fail("INVALID_ARGUMENT", "Core is stopped.");
    if (this.sessions.has(context)) fail("INVALID_ARGUMENT", `Duplicate context "${context}".`);
    const session = new SessionImpl(this, context, view);
    this.sessions.set(context, session);
    return session;
  }

  releaseSession(session: SessionImpl): void {
    if (this.sessions.get(session.context) === session) this.sessions.delete(session.context);
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
    if (!schema) fail("INVALID_ARGUMENT", `Undeclared event "${event}".`);
    let data: JsonValue;
    try {
      data = validateValue(schema, payload);
    } catch {
      fail("INVALID_ARGUMENT", "Invalid event payload.");
    }
    if (target.kind === "view" && !this.views.has(target.viewId))
      fail("INVALID_ARGUMENT", `Unknown view "${target.viewId}".`);
    for (const session of this.sessions.values()) {
      if (session.closed || session.failed || !session.helloDone) continue;
      if (target.kind === "view" && session.view.id !== target.viewId) continue;
      if (!session.view.events.includes(event)) continue;
      session.deliver(event, source, data);
    }
  }

  makeBackendContext(): CommandContext {
    const signal = this.backendController.signal;
    return {
      signal,
      host: createHostAPI(this.services.backendContext, signal, this.services.callHost),
      state: this.state,
      events: {
        emit: (event, payload, target) => this.emit(event, payload, target, "backend"),
      },
    };
  }

  addStopHook(hook: StopHook): void {
    this.stopHooks.push(hook);
  }

  // Stop hooks best-effort in reverse setup order; individual failures never
  // skip later hooks.
  async cleanupPlugins(): Promise<void> {
    for (const hook of [...this.stopHooks].reverse()) {
      try {
        await hook();
      } catch {
        // Cleanup failure must not block the remaining teardown.
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
      const sessions = [...this.sessions.values()];
      await Promise.all(sessions.map((session) => session.close()));
      await this.cleanupPlugins();
    })();
    const guard: { timer: Dispose | null } = { timer: null };
    const deadline = new Promise<never>((_, reject) => {
      guard.timer = this.services.runtime.schedule(
        () => reject(new BunawayError({ code: "TIMEOUT", message: "Core shutdown timed out." })),
        API_LIMITS.shutdownTimeoutMs,
      );
    });
    try {
      await Promise.race([cleanup, deadline]);
    } finally {
      guard.timer?.();
    }
  }
}

export const createCore: CoreFactory = async (app, services) => {
  const ordered = orderPlugins(app.plugins ?? [], services);
  const commands = new Map<string, CommandDefinition>();
  const events = new Map<string, Schema>();
  registerAll(commands, app.commands, "command", "app");
  registerAll(events, app.events, "event", "app");
  for (const plugin of ordered) {
    registerAll(commands, plugin.commands ?? {}, "command", `plugin "${plugin.name}"`);
    registerAll(events, plugin.events ?? {}, "event", `plugin "${plugin.name}"`);
  }
  commands.set(CAPABILITIES_COMMAND, capabilitiesCommand);
  const views = new Map<string, ViewPolicy>();
  for (const view of services.policy.views) {
    if (views.has(view.id)) fail("INVALID_ARGUMENT", `Duplicate policy view "${view.id}".`);
    views.set(view.id, view);
  }
  const core = new BunawayCore(services, commands, events, createStateStore(app.state), views);
  try {
    for (const plugin of ordered) {
      const hook = await plugin.setup?.(core.makeBackendContext());
      if (typeof hook === "function") core.addStopHook(hook);
    }
  } catch (cause) {
    await core.stop();
    if (cause instanceof BunawayError) throw cause;
    throw new BunawayError({ code: "INTERNAL", message: "Plugin setup failed." });
  }
  return core;
};
