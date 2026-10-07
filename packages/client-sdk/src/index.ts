import {
  API_LIMITS,
  type AsyncDispose,
  BunawayError,
  type CancellationSignal,
  type ClientMessage,
  type CommandMap,
  type Dispose,
  type EventMap,
  errorSchema,
  type Hello,
  type HostOperationContract,
  type Infer,
  type JsonValue,
  type Message,
  type NegotiatedProtocol,
  negotiateProtocol,
  ProtocolError,
  parseMessage,
  type Schema,
  serializeMessage,
  type Transport,
  type TransportEvent,
  validateValue,
  type WireError,
} from "@bunaway/protocol";
import { defaultClient } from "./default-client.ts";

export { createWebViewTransport, type WebViewBridge } from "./webview.ts";

export type InvokeOptions = { signal?: CancellationSignal; deadline?: number };
export type ListenOptions = { signal?: CancellationSignal; onError: (error: WireError) => void };
export type EventDelivery<T> = Omit<Extract<Message, { kind: "event" }>, "payload"> & {
  payload: T;
};

export interface Client<C extends CommandMap = CommandMap, E extends EventMap = EventMap> {
  readonly ready: Promise<NegotiatedProtocol>;
  invoke<K extends keyof C & string>(
    command: K,
    payload: C[K]["input"],
    options?: InvokeOptions,
  ): Promise<C[K]["output"]>;
  listen<K extends keyof E & string>(
    event: K,
    listener: (event: EventDelivery<E[K]>) => void,
    options: ListenOptions,
  ): Promise<AsyncDispose>;
  close(): Promise<void>;
}

export type ClientFactory = <
  C extends CommandMap = CommandMap,
  E extends EventMap = EventMap,
>(options: {
  transport: Transport;
  hello: Hello;
}) => Client<C, E>;

type Protocol = NegotiatedProtocol["protocol"];
type EventMessage = Extract<Message, { kind: "event" }>;
type SubscriptionErrorMessage = Extract<Message, { kind: "subscription-error" }>;

type PendingRequest = {
  onCancelledResult?: (payload: JsonValue) => void;
  // Set once the wire send is dispatched; a late settle then owes a cancel.
  sent: boolean;
  resolve: (payload: JsonValue) => void;
  reject: (error: unknown) => void;
};

type ActiveSubscription = {
  readonly subscriptionId: string;
  readonly event: string;
  readonly listener: (event: EventDelivery<JsonValue>) => void;
  readonly onError: (error: WireError) => void;
  expectedSequence: number;
  released: boolean;
  signal?: CancellationSignal;
  onAbort?: () => void;
};

const VIOLATION: WireError = { code: "INTERNAL", message: "Protocol violation." };
const CONNECTION_CLOSED: WireError = { code: "INTERNAL", message: "Connection closed." };
const CLIENT_CLOSED: WireError = { code: "CANCELLED", message: "Client closed." };

function toBunawayError(cause: unknown, fallback: WireError): BunawayError {
  if (cause instanceof BunawayError) return cause;
  if (cause instanceof ProtocolError)
    return new BunawayError({ code: cause.code, message: cause.message });
  try {
    return new BunawayError(cause as WireError);
  } catch {
    return new BunawayError(fallback);
  }
}

function requestError(code: WireError["code"], message: string): BunawayError {
  return new BunawayError({ code, message });
}

function toWireError(cause: unknown, fallback: WireError): WireError {
  if (cause instanceof BunawayError)
    return cause.details === undefined
      ? { code: cause.code, message: cause.message }
      : { code: cause.code, message: cause.message, details: cause.details };
  if (cause instanceof ProtocolError) return { code: cause.code, message: cause.message };
  try {
    return validateValue(errorSchema, cause);
  } catch {
    return fallback;
  }
}

class ClientSession<C extends CommandMap, E extends EventMap> implements Client<C, E> {
  readonly ready: Promise<NegotiatedProtocol>;

  private readonly transport: Transport;
  private readonly hello: Hello;
  private readonly requests = new Map<string, PendingRequest>();
  private readonly cancelledListens = new Map<string, (payload: JsonValue) => void>();
  private readonly subscriptions = new Map<string, ActiveSubscription>();
  private readonly unsubscribeTransport: Dispose;
  private negotiated: NegotiatedProtocol | undefined;
  private terminated = false;
  private failure: WireError = CLIENT_CLOSED;
  private rejection: BunawayError = new BunawayError(CLIENT_CLOSED);
  private closePromise: Promise<void> | undefined;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private requestIds = 0;
  private readySettled = false;
  private readyResolve: (value: NegotiatedProtocol) => void = () => {};
  private readyReject: (error: unknown) => void = () => {};

  constructor(transport: Transport, hello: Hello) {
    this.transport = transport;
    this.hello = hello;
    this.ready = new Promise<NegotiatedProtocol>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // Calls deliver the same rejection; keep a handler so ready alone never
    // surfaces as an unhandled rejection.
    void this.ready.then(
      () => {},
      () => {},
    );
    // Subscribe before the first send so no inbound frame is missed.
    this.unsubscribeTransport = () => {};
    try {
      this.unsubscribeTransport = transport.subscribe((event) => this.onTransportEvent(event));
    } catch (cause) {
      this.terminate(
        toWireError(cause, { code: "INTERNAL", message: "Transport subscribe failed." }),
      );
    }
    this.handshakeTimer = setTimeout(
      () => this.terminate({ code: "TIMEOUT", message: "Handshake timed out." }),
      API_LIMITS.handshakeTimeoutMs,
    );
    if (!this.terminated) this.sendHello();
  }

  invoke<K extends keyof C & string>(
    command: K,
    payload: C[K]["input"],
    options: InvokeOptions = {},
  ): Promise<C[K]["output"]> {
    let wireDeadline: number | undefined;
    let deadlineAt: number;
    if (options.deadline !== undefined) {
      if (!Number.isFinite(options.deadline) || options.deadline < 0)
        return Promise.reject(requestError("INVALID_ARGUMENT", "Invalid command deadline."));
      // A command deadline may not extend past the maximum execution time.
      deadlineAt = Math.min(options.deadline, Date.now() + API_LIMITS.maxCommandDurationMs);
      wireDeadline = Math.trunc(deadlineAt);
    } else {
      deadlineAt = Date.now() + API_LIMITS.maxCommandDurationMs;
    }
    return this.request(
      (id, protocol) =>
        wireDeadline === undefined
          ? { kind: "invoke", protocol, id, command, payload }
          : { kind: "invoke", protocol, id, command, payload, deadline: wireDeadline },
      { signal: options.signal, deadlineAt },
    ) as Promise<C[K]["output"]>;
  }

  async listen<K extends keyof E & string>(
    event: K,
    listener: (event: EventDelivery<E[K]>) => void,
    options: ListenOptions,
  ): Promise<AsyncDispose> {
    if (this.subscriptions.size >= API_LIMITS.maxSubscriptions)
      throw requestError("BUSY", "Subscription limit reached.");
    let release: AsyncDispose = async () => {};
    await this.request((id, protocol) => ({ kind: "listen", protocol, id, event }), {
      signal: options.signal,
      onResult: (payload) => {
        release = this.registerSubscription(event, listener, options, payload);
      },
      onCancelledResult: (payload) => {
        this.bestEffortUnlisten(this.subscriptionId(payload));
      },
    });
    return release;
  }

  private subscriptionId(payload: JsonValue): string {
    const subscriptionId =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? (payload as { subscriptionId?: unknown }).subscriptionId
        : undefined;
    if (typeof subscriptionId !== "string" || subscriptionId.length === 0)
      throw requestError("INTERNAL", "Invalid listen response.");
    return subscriptionId;
  }

  private registerSubscription<K extends keyof E & string>(
    event: K,
    listener: (event: EventDelivery<E[K]>) => void,
    options: ListenOptions,
    payload: JsonValue,
  ): AsyncDispose {
    const subscriptionId = this.subscriptionId(payload);
    const subscription: ActiveSubscription = {
      subscriptionId,
      event,
      listener: (delivery) => listener(delivery as EventDelivery<E[K]>),
      onError: options.onError,
      expectedSequence: 1,
      released: false,
    };
    let releaseRequested = false;
    let releasePromise: Promise<void> | undefined;
    const release = (): Promise<void> => {
      if (this.terminated || (subscription.released && !releaseRequested)) return Promise.resolve();
      if (releasePromise) return releasePromise;
      releaseRequested = true;
      subscription.released = true;
      this.subscriptions.delete(subscriptionId);
      this.detachSubscription(subscription);
      releasePromise = this.request(
        (id, protocol) => ({ kind: "unlisten", protocol, id, subscriptionId }),
        {},
      ).then(
        () => {},
        (cause) => {
          releasePromise = undefined;
          throw cause;
        },
      );
      return releasePromise;
    };
    if (this.terminated) {
      this.endSubscription(subscription, this.failure);
      return release;
    }
    this.subscriptions.set(subscriptionId, subscription);
    const signal = options.signal;
    if (signal) {
      const onAbort = () => {
        void release().then(
          () => {},
          () => this.terminate(CONNECTION_CLOSED),
        );
      };
      subscription.signal = signal;
      subscription.onAbort = onAbort;
      signal.addEventListener("abort", onAbort);
      if (signal.aborted) onAbort();
    }
    return release;
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.terminate(CLIENT_CLOSED);
      this.closePromise = this.transport.close().then(
        () => {},
        () => {},
      );
    }
    return this.closePromise;
  }

  private sendHello(): void {
    let text: string;
    try {
      text = serializeMessage(this.hello);
    } catch {
      this.terminate({ code: "INVALID_ARGUMENT", message: "Invalid hello." });
      return;
    }
    try {
      this.transport.send(text).then(
        () => {},
        (cause) =>
          this.terminate(toWireError(cause, { code: "INTERNAL", message: "Hello send failed." })),
      );
    } catch (cause) {
      this.terminate(toWireError(cause, { code: "INTERNAL", message: "Hello send failed." }));
    }
  }

  private request(
    build: (id: string, protocol: Protocol) => ClientMessage,
    options: {
      signal?: CancellationSignal | undefined;
      deadlineAt?: number;
      onResult?: (payload: JsonValue) => void;
      onCancelledResult?: (payload: JsonValue) => void;
    },
  ): Promise<JsonValue> {
    return new Promise<JsonValue>((resolve, reject) => {
      if (this.terminated) {
        reject(this.rejection);
        return;
      }
      const signal = options.signal;
      if (signal?.aborted) {
        reject(requestError("CANCELLED", "Request cancelled."));
        return;
      }
      if (
        this.requests.size >= API_LIMITS.maxPending ||
        this.requestIds >= API_LIMITS.maxRequestIds
      ) {
        reject(requestError("BUSY", "Pending request limit reached."));
        return;
      }
      if (options.deadlineAt !== undefined && options.deadlineAt <= Date.now()) {
        reject(requestError("TIMEOUT", "Command deadline exceeded."));
        return;
      }
      const id = `request-${++this.requestIds}`;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = signal ? () => this.cancelRequest(id) : undefined;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      };
      // Map membership is the settled flag: first completion deletes the entry.
      const pending: PendingRequest = {
        sent: false,
        ...(options.onCancelledResult ? { onCancelledResult: options.onCancelledResult } : {}),
        resolve: (result) => {
          if (!this.requests.delete(id)) return;
          cleanup();
          try {
            options.onResult?.(result);
            resolve(result);
          } catch (cause) {
            reject(cause);
          }
        },
        reject: (error) => {
          if (!this.requests.delete(id)) return;
          cleanup();
          reject(error);
        },
      };
      this.requests.set(id, pending);
      if (signal && onAbort) signal.addEventListener("abort", onAbort);
      if (options.deadlineAt !== undefined)
        timer = setTimeout(
          () => this.expireRequest(id),
          Math.max(0, options.deadlineAt - Date.now()),
        );
      this.ready.then(
        () => {
          const current = this.requests.get(id);
          const protocol = this.negotiated?.protocol;
          if (!current || !protocol || this.terminated) return;
          let text: string;
          try {
            text = serializeMessage(build(id, protocol));
          } catch (cause) {
            current.reject(
              toBunawayError(cause, { code: "INVALID_ARGUMENT", message: "Invalid request." }),
            );
            return;
          }
          current.sent = true;
          try {
            this.transport.send(text).then(
              () => {},
              (cause) =>
                this.requests
                  .get(id)
                  ?.reject(toBunawayError(cause, { code: "INTERNAL", message: "Send failed." })),
            );
          } catch (cause) {
            current.reject(toBunawayError(cause, { code: "INTERNAL", message: "Send failed." }));
          }
        },
        (cause) => this.requests.get(id)?.reject(cause),
      );
    });
  }

  private cancelRequest(id: string): void {
    const pending = this.requests.get(id);
    if (!pending) return;
    const sent = pending.sent;
    if (sent && pending.onCancelledResult) this.cancelledListens.set(id, pending.onCancelledResult);
    pending.reject(requestError("CANCELLED", "Request cancelled."));
    if (sent) this.sendCancel(id);
  }

  private expireRequest(id: string): void {
    const pending = this.requests.get(id);
    if (!pending) return;
    const sent = pending.sent;
    pending.reject(requestError("TIMEOUT", "Command deadline exceeded."));
    if (sent) this.sendCancel(id);
  }

  private sendCancel(id: string): void {
    const protocol = this.negotiated?.protocol;
    if (!protocol || this.terminated) return;
    try {
      this.transport.send(serializeMessage({ kind: "cancel", protocol, id })).then(
        () => {},
        () => {},
      );
    } catch {
      // The cancel is best effort; the request already finished locally.
    }
  }

  private onTransportEvent(event: TransportEvent): void {
    if (event.kind === "closed") {
      this.terminate(event.error ?? CONNECTION_CLOSED);
      return;
    }
    if (this.terminated) return;
    let message: Message;
    try {
      message = parseMessage(event.text);
    } catch {
      this.terminate(VIOLATION);
      return;
    }
    const negotiated = this.negotiated;
    if (!negotiated) {
      if (message.kind !== "hello") {
        this.terminate(VIOLATION);
        return;
      }
      this.completeHandshake(message);
      return;
    }
    if (
      message.protocol.major !== negotiated.protocol.major ||
      message.protocol.minor !== negotiated.protocol.minor
    ) {
      this.terminate(VIOLATION);
      return;
    }
    switch (message.kind) {
      case "result": {
        const onCancelledResult = this.cancelledListens.get(message.id);
        if (onCancelledResult) {
          this.cancelledListens.delete(message.id);
          try {
            onCancelledResult(message.payload);
          } catch {
            this.terminate(VIOLATION);
          }
          break;
        }
        this.requests.get(message.id)?.resolve(message.payload);
        break;
      }
      case "error": {
        const pending = this.requests.get(message.id);
        // A host deadline can precede delivery of an already-created subscription.
        if (message.error.code === "TIMEOUT") {
          if (pending?.onCancelledResult)
            this.cancelledListens.set(message.id, pending.onCancelledResult);
        } else this.cancelledListens.delete(message.id);
        pending?.reject(toBunawayError(message.error, CONNECTION_CLOSED));
        break;
      }
      case "event":
        this.deliverEvent(message);
        break;
      case "subscription-error":
        this.failSubscription(message);
        break;
      default:
        // Inbound hello/invoke/cancel/listen/unlisten have no allowed direction.
        this.terminate(VIOLATION);
    }
  }

  private completeHandshake(remote: Hello): void {
    let negotiated: Pick<Hello, "protocol" | "features">;
    try {
      negotiated = negotiateProtocol(this.hello, remote);
    } catch (cause) {
      this.terminate(toWireError(cause, { code: "UNSUPPORTED", message: "Handshake failed." }));
      return;
    }
    this.negotiated = {
      protocol: negotiated.protocol,
      features: negotiated.features,
      buildId: remote.buildId,
    };
    if (this.handshakeTimer !== undefined) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
    this.readySettled = true;
    this.readyResolve(this.negotiated);
  }

  private deliverEvent(message: EventMessage): void {
    const subscription = this.subscriptions.get(message.subscriptionId);
    if (!subscription) return;
    if (
      message.event !== subscription.event ||
      message.sequence !== subscription.expectedSequence
    ) {
      this.endSubscription(subscription, {
        code: "INTERNAL",
        message: "Event sequence violated.",
      });
      this.bestEffortUnlisten(subscription.subscriptionId);
      return;
    }
    subscription.expectedSequence += 1;
    try {
      subscription.listener(message);
    } catch {
      // A user callback must not break other requests or the receive loop.
    }
  }

  private failSubscription(message: SubscriptionErrorMessage): void {
    const subscription = this.subscriptions.get(message.subscriptionId);
    if (subscription) this.endSubscription(subscription, message.error);
  }

  private endSubscription(subscription: ActiveSubscription, error: WireError): void {
    if (subscription.released) return;
    subscription.released = true;
    this.subscriptions.delete(subscription.subscriptionId);
    this.detachSubscription(subscription);
    try {
      subscription.onError(error);
    } catch {
      // A user callback must not break other requests or the receive loop.
    }
  }

  private detachSubscription(subscription: ActiveSubscription): void {
    if (subscription.signal && subscription.onAbort)
      subscription.signal.removeEventListener("abort", subscription.onAbort);
  }

  private bestEffortUnlisten(subscriptionId: string): void {
    if (this.terminated) return;
    void this.request(
      (id, protocol) => ({ kind: "unlisten", protocol, id, subscriptionId }),
      {},
    ).then(
      () => {},
      () => this.terminate(CONNECTION_CLOSED),
    );
  }

  private terminate(error: WireError): void {
    if (this.terminated) return;
    this.terminated = true;
    this.cancelledListens.clear();
    this.failure = error;
    this.rejection = toBunawayError(error, CONNECTION_CLOSED);
    if (this.handshakeTimer !== undefined) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
    if (!this.readySettled) {
      this.readySettled = true;
      this.readyReject(this.rejection);
    }
    for (const pending of [...this.requests.values()]) pending.reject(this.rejection);
    for (const subscription of [...this.subscriptions.values()])
      this.endSubscription(subscription, error);
    this.unsubscribeTransport();
    void this.transport.close().then(
      () => {},
      () => {},
    );
  }
}

export function createClient<
  C extends CommandMap = CommandMap,
  E extends EventMap = EventMap,
>(options?: { transport: Transport; hello: Hello }): Client<C, E> {
  if (options === undefined) return defaultClient(createClient) as Client<C, E>;
  return new ClientSession<C, E>(options.transport, options.hello);
}

/** Invoke an app command through the document's shared WebView connection. */
export async function invoke<T extends JsonValue = JsonValue>(
  command: string,
  payload: JsonValue,
  options?: InvokeOptions,
): Promise<T> {
  return createClient().invoke(command, payload, options) as Promise<T>;
}

/** Invoke a native plugin operation through the document's shared connection. */
export async function invokePlugin<I extends Schema, O extends Schema>(
  contract: HostOperationContract<I, O>,
  input: Infer<I>,
  options?: InvokeOptions,
): Promise<Infer<O>> {
  let payload: Infer<I>;
  try {
    payload = validateValue(contract.input, input);
  } catch {
    throw new BunawayError({ code: "INVALID_ARGUMENT", message: "Invalid plugin input." });
  }
  const output = await invoke(`plugin.${contract.name}`, payload, options);
  try {
    return validateValue(contract.output, output);
  } catch {
    throw new BunawayError({ code: "INTERNAL", message: "Invalid plugin response." });
  }
}

/** Subscribe through the shared connection; returns a subscription disposer. */
export async function listen<T extends JsonValue = JsonValue>(
  event: string,
  listener: (event: EventDelivery<T>) => void,
  options: ListenOptions,
): Promise<AsyncDispose> {
  return createClient().listen(
    event,
    listener as (event: EventDelivery<JsonValue>) => void,
    options,
  );
}
