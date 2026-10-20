import {
  BunawayError,
  type CancellationSignal,
  type CommandMap,
  type Dispose,
  type EventMap,
  type Hello,
  type JsonValue,
  type Message,
  PROTOCOL_VERSION,
  parseMessage,
  SDK_READY_FEATURE,
  serializeMessage,
  type Transport,
  type TransportEvent,
  type WireError,
} from "@bunaway/protocol";

/** Request details passed to a mock command handler. */
export type MockCommandContext = {
  /** Aborts when the client cancels the request or the transport closes. */
  signal: CancellationSignal;
  /** Absolute `Date.now()` deadline the client sent with the request, when present. */
  deadline?: number;
};

/** Command handlers keyed by command name, typed from the same map as `createClient<C, E>()`. */
export type MockHandlers<C extends CommandMap> = {
  [K in keyof C & string]?: (
    input: C[K]["input"],
    context: MockCommandContext,
  ) => C[K]["output"] | Promise<C[K]["output"]>;
};

/** Options for `createMockTransport`. */
export type MockTransportOptions<C extends CommandMap> = {
  /** Answers each invoked command; a command without a handler fails with `UNSUPPORTED`. */
  handlers: MockHandlers<C>;
  /** Features the mock host offers in its hello. Defaults to the SDK readiness feature. */
  features?: string[];
};

/** A `Transport` backed by in-memory handlers, plus a way to push events to subscribers. */
export interface MockTransport<E extends EventMap = EventMap>
  extends Transport {
  /** Delivers an event to every active subscription for `event`; no-op when none exist. Throws if the payload is not valid protocol JSON. */
  emit<K extends keyof E & string>(event: K, payload: E[K]): void;
}

const MOCK_HOST = "mock";

type Subscription = {
  event: string;
  sequence: number;
};

/**
 * Creates a host-less transport for developing a UI in a plain browser or testing it in a unit test.
 *
 * It answers the hello, runs `handlers` for `invoke`, accepts `listen` and `unlisten`, and
 * forwards `emit` to subscribers, so a real `createClient` session runs against it. It only
 * checks protocol frames: the app's command and event schemas, permissions, and view policy
 * are not applied, so test those against the real host.
 */
export function createMockTransport<
  C extends CommandMap = CommandMap,
  E extends EventMap = EventMap,
>(options: MockTransportOptions<C>): MockTransport<E> {
  return new MockHost<C, E>(options);
}

class MockHost<C extends CommandMap, E extends EventMap>
  implements MockTransport<E>
{
  private readonly listeners = new Set<(event: TransportEvent) => void>();
  private readonly handlers: MockHandlers<C>;
  private readonly features: string[];
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly running = new Map<string, Run>();
  private nextSubscription = 1;
  private closed = false;

  constructor(options: MockTransportOptions<C>) {
    this.handlers = options.handlers;
    this.features = [
      ...(options.features ?? [
        SDK_READY_FEATURE,
      ]),
    ];
    // Fail at construction on a hello the protocol rejects instead of stalling the handshake.
    serializeMessage(this.helloFrame());
  }

  send(text: string): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("Transport closed."));
    }
    let message: Message;
    try {
      message = parseMessage(text);
    } catch (cause) {
      return Promise.reject(cause);
    }
    this.receive(message);
    return Promise.resolve();
  }

  subscribe(listener: (event: TransportEvent) => void): Dispose {
    this.listeners.add(listener);
    if (this.closed) {
      queueMicrotask(() =>
        listener({
          kind: "closed",
        }),
      );
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    this.closed = true;
    for (const run of this.running.values()) {
      run.abort();
    }
    this.running.clear();
    this.subscriptions.clear();
    for (const listener of [
      ...this.listeners,
    ]) {
      listener({
        kind: "closed",
      });
    }
    this.listeners.clear();
    return Promise.resolve();
  }

  emit<K extends keyof E & string>(event: K, payload: E[K]): void {
    if (this.closed) {
      return;
    }
    for (const [subscriptionId, subscription] of [
      ...this.subscriptions,
    ]) {
      if (subscription.event !== event) {
        continue;
      }
      // Serialize first: a payload the protocol rejects throws here and consumes no sequence number.
      const text = serializeMessage({
        kind: "event",
        protocol: PROTOCOL_VERSION,
        subscriptionId,
        source: MOCK_HOST,
        target: MOCK_HOST,
        event,
        sequence: subscription.sequence,
        payload,
      });
      subscription.sequence += 1;
      this.deliver(text);
    }
  }

  private receive(message: Message): void {
    switch (message.kind) {
      case "hello":
        // Answer on a later microtask, not inside send, so the reply never re-enters the sender.
        queueMicrotask(() => this.replyHello());
        return;
      case "invoke":
        void this.invoke(message.id, message.command, message.payload, {
          ...(message.deadline === undefined
            ? {}
            : {
                deadline: message.deadline,
              }),
        });
        return;
      case "cancel":
        this.running.get(message.id)?.abort();
        return;
      case "listen": {
        const subscriptionId = `mock-subscription-${this.nextSubscription}`;
        this.nextSubscription += 1;
        // Register with the result so no event can name an ID the client has not received.
        queueMicrotask(() => {
          if (this.closed) {
            return;
          }
          this.subscriptions.set(subscriptionId, {
            event: message.event,
            sequence: 1,
          });
          this.reply({
            kind: "result",
            protocol: PROTOCOL_VERSION,
            id: message.id,
            payload: {
              subscriptionId,
            },
          });
        });
        return;
      }
      case "unlisten":
        this.subscriptions.delete(message.subscriptionId);
        queueMicrotask(() =>
          this.reply({
            kind: "result",
            protocol: PROTOCOL_VERSION,
            id: message.id,
            payload: null,
          }),
        );
        return;
      default:
        // sdk-ready and close need no answer; server frames are not valid from a client.
        return;
    }
  }

  private helloFrame(): Hello {
    return {
      kind: "hello",
      protocol: PROTOCOL_VERSION,
      features: this.features,
      buildId: "bunaway-mock-host",
    };
  }

  private replyHello(): void {
    this.reply(this.helloFrame());
  }

  private async invoke(
    id: string,
    command: string,
    payload: JsonValue,
    request: {
      deadline?: number;
    },
  ): Promise<void> {
    // Own keys only: "toString" or "constructor" must not resolve to Object.prototype members.
    const handler = Object.hasOwn(this.handlers, command)
      ? (
          this.handlers as Record<
            string,
            (
              input: JsonValue,
              context: MockCommandContext,
            ) => JsonValue | Promise<JsonValue>
          >
        )[command]
      : undefined;
    if (handler === undefined) {
      this.replyError(id, {
        code: "UNSUPPORTED",
        message: "Command is not registered.",
      });
      return;
    }
    const run = createRun();
    this.running.set(id, run);
    try {
      const output = await handler(payload, {
        signal: run.signal,
        ...request,
      });
      if (!run.aborted && !this.closed) {
        this.reply({
          kind: "result",
          protocol: PROTOCOL_VERSION,
          id,
          payload: output,
        });
      }
    } catch (cause) {
      if (!run.aborted && !this.closed) {
        this.replyError(id, toWireError(cause));
      }
    } finally {
      this.running.delete(id);
    }
  }

  /** Errors come from `toWireError` or fixed text, so they always satisfy the protocol schema. */
  private replyError(id: string, error: WireError): void {
    this.deliver(
      serializeMessage({
        kind: "error",
        protocol: PROTOCOL_VERSION,
        id,
        error,
      }),
    );
  }

  /** Serializes with the protocol's own checks; a result it rejects becomes an INTERNAL error. */
  private reply(message: Message): void {
    let text: string;
    try {
      text = serializeMessage(message);
    } catch {
      if (message.kind === "result") {
        this.replyError(message.id, {
          code: "INTERNAL",
          message: "Invalid command response.",
        });
      }
      return;
    }
    this.deliver(text);
  }

  private deliver(text: string): void {
    if (this.closed) {
      return;
    }
    for (const listener of [
      ...this.listeners,
    ]) {
      listener({
        kind: "message",
        text,
      });
    }
  }
}

type Run = {
  signal: CancellationSignal;
  aborted: boolean;
  abort: () => void;
};

function createRun(): Run {
  const abortListeners = new Set<() => void>();
  const run: Run = {
    aborted: false,
    abort() {
      if (run.aborted) {
        return;
      }
      run.aborted = true;
      for (const listener of [
        ...abortListeners,
      ]) {
        // Like AbortSignal, a throwing listener must not stop the others or the caller.
        try {
          listener();
        } catch {
          // The handler owns its listener's failures.
        }
      }
    },
    signal: {
      get aborted() {
        return run.aborted;
      },
      addEventListener(_type: "abort", listener: () => void) {
        abortListeners.add(listener);
      },
      removeEventListener(_type: "abort", listener: () => void) {
        abortListeners.delete(listener);
      },
    },
  };
  return run;
}

function toWireError(cause: unknown): WireError {
  if (cause instanceof BunawayError) {
    return {
      code: cause.code,
      message: cause.message,
      ...(cause.details === undefined
        ? {}
        : {
            details: cause.details,
          }),
    };
  }
  return {
    code: "INTERNAL",
    message: "Command failed.",
  };
}
