import {
  API_LIMITS,
  BunawayError,
  type ClientMessage,
  type HostContext,
  MAX_MESSAGE_BYTES,
  type Policy,
  PROTOCOL_VERSION,
  parseMessage,
  SDK_READY_FEATURE,
  type ServerMessage,
  serializeMessage,
  type WireError,
} from "@bunaway/protocol";
import type { Packet, Route } from "./worker-channel.ts";

const key = (source: string) => source.split("#")[0];

type ParsedMessage = ReturnType<typeof parseMessage>;

/** State of the one protocol session a view holds for its current document. */
type ViewSession = {
  route: Route;
  source: string;
  negotiated: boolean;
  sdkReadyAllowed: boolean;
  sdkReady: boolean;
  used: Set<string>;
  // Cancelled requests still own their IDs until the terminal reply is discarded.
  cancelled: Set<string>;
  pending: Map<
    string,
    {
      kind: string;
      expiry: number;
      event?: string;
    }
  >;
  subscriptions: Map<
    string,
    {
      sequence: number;
      event: string;
    }
  >;
};

/** Recovers a valid correlation id from a raw message; rejected payloads never enter logs. */
function recoverRequestId(raw: string): string {
  if (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) {
    return "";
  }
  const value = JSON.parse(raw);
  return value && typeof value.id === "string" ? value.id : "";
}

function assertSessionSource(
  session: {
    source: string;
  },
  source: string,
) {
  if (key(source) !== key(session.source)) {
    throw new BunawayError({
      code: "PERMISSION_DENIED",
      message: "Session source mismatch.",
    });
  }
}

/** Owns the WebView-to-host protocol session for one view and its current document. */
export class ViewBoundary {
  generation = 0;
  closed = false;
  private session: ViewSession | undefined;
  constructor(
    readonly policy: Policy["views"][number],
    private readonly hooks: {
      origin(source: string): string;
      source(): string;
      ready(): boolean;
      forward(packet: Packet): void;
      capacity(count: number): boolean;
      deliver(text: string): void;
      log(event: string, data?: object): void;
      /** Optional native lifecycle observers; these never change session authorization. */
      sdkReady?(route: Route): void;
      sessionOpened?(route: Route): void;
      revoked?(reason: string, generation: number, error?: WireError): void;
      /**
       * Called after a subscription attempt for `event` ends without leaving that subscription
       * active: a confirmed subscription removed by the client's `unlisten` or by the host, or a
       * pending `listen` that Core answered with an error. Another pending `listen` for the same
       * event may still keep `eventRoute(event)` defined, so observers that need a confirmed
       * subscription should re-check `subscribed(event)`.
       */
      subscriptionEnded?(event: string): void;
    },
  ) {}
  private error(id: string, error: WireError) {
    if (/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) {
      this.hooks.deliver(
        serializeMessage({
          kind: "error",
          protocol: PROTOCOL_VERSION,
          id,
          error,
        }),
      );
    }
  }

  /** Validates and forwards WebView input; `source` must come from the renderer, not the message body. */
  receive(source: string, raw: string) {
    let id = "";
    try {
      id = recoverRequestId(raw);
      const message = this.parseWebMessage(raw);
      this.assertAccepting(source);
      if (message.kind === "close") {
        this.closeFromClient(source);
        return;
      }
      const session = this.session
        ? this.admitToSession(this.session, source, message)
        : this.openSession(source, message);
      if (message.kind === "sdk-ready") {
        this.acceptSdkReady(session);
        return;
      }
      this.assertPolicyAllows(message);
      if (
        message.kind === "invoke" ||
        message.kind === "listen" ||
        message.kind === "unlisten"
      ) {
        this.reserveRequest(session, message);
      } else if (
        message.kind === "cancel" &&
        !this.cancelRequest(session, message.id)
      ) {
        return;
      }
      this.hooks.forward({
        kind: "client",
        route: session.route,
        message: message as ClientMessage,
      });
      this.hooks.log("web-message", {
        context: session.route.context,
        kind: message.kind,
      });
    } catch (error) {
      this.hooks.log("web-message-rejected", {
        reason: error instanceof BunawayError ? error.code : "malformed",
      });
      this.error(
        id,
        error instanceof BunawayError
          ? {
              code: error.code,
              message: error.message,
            }
          : {
              code: "INVALID_ARGUMENT",
              message: "Rejected Web message.",
            },
      );
    }
  }

  /** Parses a WebView message and rejects wrong directions and protocol versions. */
  private parseWebMessage(raw: string): ParsedMessage {
    const message = parseMessage(raw);
    // Structured-clone delivery still needs a bounded canonical wire form.
    // Check before reserving a request id (e.g. compact exponent numbers expand).
    serializeMessage(message);
    if (
      ![
        "hello",
        "sdk-ready",
        "invoke",
        "listen",
        "unlisten",
        "cancel",
        "close",
      ].includes(message.kind)
    ) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Invalid Web direction.",
      });
    }
    if (
      message.protocol.major !== PROTOCOL_VERSION.major ||
      message.protocol.minor !== PROTOCOL_VERSION.minor
    ) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Protocol version mismatch.",
      });
    }
    return message;
  }

  /** Requires a ready backend and a renderer source that is the current document of an allowed origin. */
  private assertAccepting(source: string) {
    if (this.closed || !this.hooks.ready()) {
      throw new BunawayError({
        code: "BUSY",
        message: "Backend is not ready.",
      });
    }
    // Source comes from the renderer, never the JSON. Top-level handler + current actual document.
    if (
      !this.policy.origins.includes(this.hooks.origin(source)) ||
      key(source) !== key(this.hooks.source())
    ) {
      throw new BunawayError({
        code: "PERMISSION_DENIED",
        message: "Message source is not allowed.",
      });
    }
  }

  /** Revokes the session on a client close from the session's own document; no session means nothing to close. */
  private closeFromClient(source: string) {
    if (!this.session) {
      return;
    }
    assertSessionSource(this.session, source);
    // A terminal notification must still fit when request capacity is full.
    this.revoke("client-close");
  }

  /** Publishes the session for the first hello, after reserving room for session-open and that hello. */
  private openSession(source: string, message: ParsedMessage): ViewSession {
    if (message.kind !== "hello") {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "First message must be hello.",
      });
    }
    if (!this.hooks.capacity(2)) {
      throw new BunawayError({
        code: "BUSY",
        message: "UI channel is full.",
      });
    }
    // Reserve space for both session-open and the first client hello before publishing a session.
    const route = {
      viewId: this.policy.id,
      documentGeneration: this.generation,
      context: `ctx-${crypto.randomUUID()}` as HostContext,
    };
    const session: ViewSession = {
      route,
      source,
      negotiated: false,
      sdkReadyAllowed: message.features.includes(SDK_READY_FEATURE),
      sdkReady: false,
      used: new Set(),
      cancelled: new Set(),
      pending: new Map(),
      subscriptions: new Map(),
    };
    this.session = session;
    this.hooks.sessionOpened?.(route);
    this.hooks.forward({
      kind: "session-open",
      route,
    });
    this.hooks.log("session-open", {
      context: route.context,
      viewId: route.viewId,
      origin: this.hooks.origin(source),
    });
    return session;
  }

  /** Checks a follow-up message against the open session: source, hello order, negotiation and capacity. */
  private admitToSession(
    session: ViewSession,
    source: string,
    message: ParsedMessage,
  ): ViewSession {
    assertSessionSource(session, source);
    if (message.kind === "hello") {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Duplicate hello.",
      });
    }
    if (!session.negotiated) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Session is not negotiated.",
      });
    }
    // SDK readiness is handled locally and consumes no Worker channel slot.
    if (
      message.kind !== "cancel" &&
      message.kind !== "sdk-ready" &&
      !this.hooks.capacity(1)
    ) {
      throw new BunawayError({
        code: "BUSY",
        message: "UI channel is full.",
      });
    }
    return session;
  }

  private acceptSdkReady(session: ViewSession) {
    if (!session.sdkReadyAllowed || !session.negotiated) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "SDK readiness was not negotiated.",
      });
    }
    if (!session.sdkReady) {
      session.sdkReady = true;
      this.hooks.sdkReady?.(session.route);
    }
  }

  /** Rejects commands and events the view's policy does not list, logging the denied name. */
  private assertPolicyAllows(message: ParsedMessage) {
    if (
      message.kind === "invoke" &&
      !this.policy.commands.includes(message.command)
    ) {
      this.hooks.log("permission-denied", {
        kind: "command",
        name: message.command,
      });
      throw new BunawayError({
        code: "PERMISSION_DENIED",
        message: "Command is not allowed for this view.",
      });
    }
    if (
      message.kind === "listen" &&
      !this.policy.events.includes(message.event)
    ) {
      this.hooks.log("permission-denied", {
        kind: "event",
        name: message.event,
      });
      throw new BunawayError({
        code: "PERMISSION_DENIED",
        message: "Event is not allowed for this view.",
      });
    }
  }

  /** Reserves the request id, pending slot and deadline for an invoke, listen or unlisten. */
  private reserveRequest(
    session: ViewSession,
    message: Extract<
      ParsedMessage,
      {
        kind: "invoke" | "listen" | "unlisten";
      }
    >,
  ) {
    if (
      session.used.has(message.id) ||
      session.pending.has(message.id) ||
      session.cancelled.has(message.id)
    ) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Request ID was already used.",
      });
    }
    if (
      session.pending.size + session.cancelled.size >= API_LIMITS.maxPending ||
      (message.kind === "listen" &&
        session.subscriptions.size +
          [
            ...session.pending.values(),
          ].filter((p) => p.kind === "listen").length >=
          API_LIMITS.maxSubscriptions)
    ) {
      throw new BunawayError({
        code: "BUSY",
        message: "Request limit reached.",
      });
    }
    const duration =
      message.kind === "invoke" && message.deadline !== undefined
        ? Math.min(
            message.deadline - Date.now(),
            API_LIMITS.maxCommandDurationMs,
          )
        : API_LIMITS.maxCommandDurationMs;
    if (duration <= 0) {
      throw new BunawayError({
        code: "TIMEOUT",
        message: "Request deadline passed.",
      });
    }
    session.used.add(message.id);
    if (session.used.size > API_LIMITS.maxRequestIds) {
      // Match Core's acceptance order even while a completed reply is in transit.
      // Active and cancelled requests protect IDs outside this recent history.
      const oldest = session.used.values().next().value;
      if (oldest !== undefined) {
        session.used.delete(oldest);
      }
    }
    session.pending.set(message.id, {
      kind: message.kind,
      expiry: performance.now() + duration,
      ...(message.kind === "listen"
        ? {
            event: message.event,
          }
        : {}),
    });
    if (message.kind === "unlisten") {
      this.endSubscription(session.subscriptions, message.subscriptionId);
    }
  }

  /** Cancels a pending request; returns whether the cancel still needs forwarding to the host. */
  private cancelRequest(session: ViewSession, id: string): boolean {
    const pending = session.pending.get(id);
    if (pending?.kind === "listen") {
      // Core creates subscriptions synchronously. Preserve the late result so
      // the SDK can unlisten, even if delivery outlasts the original deadline.
      pending.expiry = Number.POSITIVE_INFINITY;
      return false;
    }
    // Ignore repeated/unknown cancellations so Web input cannot flood reserved slots.
    if (!session.pending.delete(id)) {
      return false;
    }
    session.cancelled.add(id);
    this.error(id, {
      code: "CANCELLED",
      message: "Request cancelled.",
    });
    return true;
  }
  /** Captures the current negotiated document route for host-originated events. */
  eventRoute(event: string): Route | undefined {
    const session = this.eventSession(event);
    if (!session) {
      return undefined;
    }
    // A listen can already be registered in Core while its result is still crossing the channel.
    for (const request of session.pending.values()) {
      if (request.kind === "listen" && request.event === event) {
        return session.route;
      }
    }
    return this.subscribed(event) ? session.route : undefined;
  }
  /**
   * Whether the current document holds a confirmed subscription to `event`. Unlike `eventRoute`, a
   * `listen` whose result has not been delivered yet does not count, because Core may still reject it.
   */
  subscribed(event: string): boolean {
    const session = this.eventSession(event);
    if (!session) {
      return false;
    }
    for (const subscription of session.subscriptions.values()) {
      if (subscription.event === event) {
        return true;
      }
    }
    return false;
  }
  /** The negotiated session of an open boundary whose policy allows `event`, if any. */
  private eventSession(event: string) {
    const session = this.session;
    if (
      this.closed ||
      !session?.negotiated ||
      !this.policy.events.includes(event)
    ) {
      return undefined;
    }
    return session;
  }

  matches(route: Route) {
    return (
      !this.closed &&
      this.session?.route.context === route.context &&
      route.viewId === this.policy.id &&
      route.documentGeneration === this.generation
    );
  }
  active(context: HostContext) {
    return !this.closed && this.session?.route.context === context;
  }

  /** Updates the trusted URI after a same-document navigation; a disallowed origin cannot retarget the session. */
  sameDocument(source: string) {
    if (
      this.session &&
      this.policy.origins.includes(this.hooks.origin(source))
    ) {
      this.session.source = source;
    }
  }

  /** Invalidates current-document routes before notifying the host, so late replies cannot reach this session. */
  revoke(reason: string, error?: WireError) {
    this.generation++;
    const session = this.session;
    this.session = undefined;
    this.hooks.revoked?.(reason, this.generation, error);
    if (!session) {
      return;
    }
    this.hooks.forward({
      kind: "revoke",
      route: session.route,
    });
    this.hooks.log("revoke", {
      context: session.route.context,
      reason,
    });
  }

  /** Fails requests and subscriptions on the matching route, then revokes it; stale routes are ignored. */
  fail(route: Route, error: WireError): void {
    if (!this.matches(route) || !this.session) {
      return;
    }
    for (const id of this.session.pending.keys()) {
      this.error(id, error);
    }
    for (const subscriptionId of this.session.subscriptions.keys()) {
      this.hooks.deliver(
        serializeMessage({
          kind: "subscription-error",
          protocol: PROTOCOL_VERSION,
          subscriptionId,
          error,
        }),
      );
    }
    this.revoke(error.code, error);
  }

  /**
   * Delivers validated messages on active routes; discards stale routes, late
   * replies, and events for inactive subscriptions. Invalid active-route messages throw.
   */
  send(route: Route, message: ServerMessage) {
    if (!this.matches(route) || !this.session) {
      this.hooks.log("discarded", {
        reason: "inactive-context",
      });
      return;
    }
    const session = this.session;
    const text = serializeMessage(message);
    if (message.kind === "hello") {
      if (session.negotiated) {
        throw new Error("Duplicate server hello");
      }
      session.negotiated = true;
      session.sdkReadyAllowed &&= message.features.includes(SDK_READY_FEATURE);
    } else if (message.kind === "result" || message.kind === "error") {
      if (!this.settleReply(session, message)) {
        return;
      }
    } else if (message.kind === "event") {
      if (!this.acceptEvent(session, message)) {
        return;
      }
    } else {
      this.endSubscription(session.subscriptions, message.subscriptionId);
    }
    this.hooks.deliver(text);
    this.hooks.log("web-delivered", {
      context: route.context,
      kind: message.kind,
      ...("id" in message
        ? {
            id: message.id,
          }
        : {}),
      ...(message.kind === "event"
        ? {
            name: message.event,
          }
        : {}),
    });
  }

  /**
   * Completes the pending request a result or error answers, recording a new
   * subscription for a successful listen. Returns false when the reply is late
   * or expired and must not reach the WebView.
   */
  private settleReply(
    session: ViewSession,
    message: Extract<
      ServerMessage,
      {
        kind: "result" | "error";
      }
    >,
  ): boolean {
    if (session.cancelled.delete(message.id)) {
      this.hooks.log("discarded", {
        reason: "late-response",
        id: message.id,
      });
      return false;
    }
    const pending = session.pending.get(message.id);
    if (!pending) {
      this.hooks.log("discarded", {
        reason: "late-response",
        id: message.id,
      });
      return false;
    }
    if (performance.now() >= pending.expiry) {
      this.expire(message.id);
      if (pending.kind !== "listen") {
        // This response already completes the cleanup reservation just created by expire.
        session.cancelled.delete(message.id);
        return false;
      }
    }
    if (pending.kind === "listen" && message.kind === "result") {
      const value = message.payload as {
        subscriptionId?: unknown;
      };
      if (
        !value ||
        typeof value.subscriptionId !== "string" ||
        Object.keys(value).length !== 1
      ) {
        throw new Error("Invalid subscription result");
      }
      session.subscriptions.set(value.subscriptionId, {
        sequence: 0,
        event: pending.event ?? "",
      });
    }
    session.pending.delete(message.id);
    if (
      pending.kind === "listen" &&
      message.kind === "error" &&
      pending.event
    ) {
      // The pending listen that kept eventRoute(event) defined is gone; observers re-check.
      this.hooks.subscriptionEnded?.(pending.event);
    }
    return true;
  }

  /** Checks an event against its subscription and advances the sequence; false means the subscription is inactive. */
  private acceptEvent(
    session: ViewSession,
    message: Extract<
      ServerMessage,
      {
        kind: "event";
      }
    >,
  ): boolean {
    const subscription = session.subscriptions.get(message.subscriptionId);
    if (!subscription) {
      this.hooks.log("discarded", {
        reason: "inactive-subscription",
      });
      return false;
    }
    if (
      message.target !== this.policy.id ||
      message.event !== subscription.event ||
      message.sequence !== subscription.sequence + 1 ||
      !this.policy.events.includes(message.event)
    ) {
      throw new Error("Invalid event delivery");
    }
    subscription.sequence = message.sequence;
    return true;
  }
  /** Removes a subscription and reports its event; unknown IDs are ignored without notification. */
  private endSubscription(
    subscriptions: Map<
      string,
      {
        event: string;
      }
    >,
    subscriptionId: string,
  ) {
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription) {
      return;
    }
    subscriptions.delete(subscriptionId);
    this.hooks.subscriptionEnded?.(subscription.event);
  }
  private expire(id: string) {
    const session = this.session;
    const pending = session?.pending.get(id);
    if (!session || !pending) {
      return;
    }
    if (pending.kind === "listen") {
      // Keep the reservation and late subscription ID for SDK cleanup after TIMEOUT.
      pending.expiry = Number.POSITIVE_INFINITY;
    } else {
      session.pending.delete(id);
      session.cancelled.add(id);
      this.hooks.forward({
        kind: "client",
        route: session.route,
        message: {
          kind: "cancel",
          protocol: PROTOCOL_VERSION,
          id,
        },
      });
    }
    this.error(id, {
      code: "TIMEOUT",
      message: "Request deadline exceeded.",
    });
    this.hooks.log("request-timeout", {
      id,
    });
  }

  /** Expires outstanding requests; invoke expirations cancel host work, while listen expirations retain cleanup IDs. */
  scanDeadlines() {
    for (const [id, pending] of this.session?.pending ?? []) {
      if (performance.now() >= pending.expiry) {
        this.expire(id);
      }
    }
  }
  /** Requests that may still send a cancel; already-cancelled IDs need no channel reservation. */
  get pendingCount() {
    return this.session?.pending.size ?? 0;
  }
}
