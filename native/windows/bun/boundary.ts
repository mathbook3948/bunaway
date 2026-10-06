import {
  API_LIMITS,
  BunawayError,
  type ClientMessage,
  type HostCall,
  type HostContext,
  type Policy,
  PROTOCOL_VERSION,
  parseHostCall,
  parseMessage,
  type ServerMessage,
  serializeMessage,
  type WireError,
} from "../../../packages/protocol/src/index.ts";
import type { Packet, Route } from "./channel.ts";

const key = (source: string) => source.split("#")[0];
export class ViewBoundary {
  generation = 0;
  closed = false;
  private session:
    | {
        route: Route;
        source: string;
        negotiated: boolean;
        used: Set<string>;
        pending: Map<string, { kind: string; expiry: number; event?: string }>;
        subscriptions: Map<string, { sequence: number; event: string }>;
      }
    | undefined;
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
    },
  ) {}
  private error(id: string, error: WireError) {
    if (/^[A-Za-z0-9_.:-]{1,128}$/.test(id))
      this.hooks.deliver(
        serializeMessage({ kind: "error", protocol: PROTOCOL_VERSION, id, error }),
      );
  }
  receive(source: string, raw: string) {
    let id = "";
    try {
      // Only a valid correlation id is recovered; rejected payloads never enter logs.
      if (Buffer.byteLength(raw) <= 1024 * 1024) {
        const value = JSON.parse(raw);
        if (value && typeof value.id === "string") id = value.id;
      }
      const message = parseMessage(raw);
      // Structured-clone delivery still needs a bounded canonical wire form.
      // Check before reserving a request id (e.g. compact exponent numbers expand).
      serializeMessage(message);
      if (!["hello", "invoke", "listen", "unlisten", "cancel"].includes(message.kind))
        throw new BunawayError({ code: "INVALID_ARGUMENT", message: "Invalid Web direction." });
      if (
        message.protocol.major !== PROTOCOL_VERSION.major ||
        message.protocol.minor !== PROTOCOL_VERSION.minor
      )
        throw new BunawayError({ code: "INVALID_ARGUMENT", message: "Protocol version mismatch." });
      if (this.closed || !this.hooks.ready())
        throw new BunawayError({ code: "BUSY", message: "Backend is not ready." });
      // Source comes from WebView2, never the JSON. Top-level handler + current actual document.
      if (
        !this.policy.origins.includes(this.hooks.origin(source)) ||
        key(source) !== key(this.hooks.source())
      )
        throw new BunawayError({
          code: "PERMISSION_DENIED",
          message: "Message source is not allowed.",
        });
      if (!this.session) {
        if (message.kind !== "hello")
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "First message must be hello.",
          });
        if (!this.hooks.capacity(2))
          throw new BunawayError({ code: "BUSY", message: "UI channel is full." });
        const route = {
          viewId: this.policy.id,
          documentGeneration: this.generation,
          context: `ctx-${crypto.randomUUID()}` as HostContext,
        };
        this.session = {
          route,
          source,
          negotiated: false,
          used: new Set(),
          pending: new Map(),
          subscriptions: new Map(),
        };
        this.hooks.forward({ kind: "session-open", route });
        this.hooks.log("session-open", {
          context: route.context,
          viewId: route.viewId,
          origin: this.hooks.origin(source),
        });
      } else {
        if (key(source) !== key(this.session.source))
          throw new BunawayError({
            code: "PERMISSION_DENIED",
            message: "Session source mismatch.",
          });
        if (message.kind === "hello")
          throw new BunawayError({ code: "INVALID_ARGUMENT", message: "Duplicate hello." });
        if (!this.session.negotiated)
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "Session is not negotiated.",
          });
        if (message.kind !== "cancel" && !this.hooks.capacity(1))
          throw new BunawayError({ code: "BUSY", message: "UI channel is full." });
      }
      const session = this.session;
      if (message.kind === "invoke" && !this.policy.commands.includes(message.command)) {
        this.hooks.log("permission-denied", { kind: "command", name: message.command });
        throw new BunawayError({
          code: "PERMISSION_DENIED",
          message: "Command is not allowed for this view.",
        });
      }
      if (message.kind === "listen" && !this.policy.events.includes(message.event)) {
        this.hooks.log("permission-denied", { kind: "event", name: message.event });
        throw new BunawayError({
          code: "PERMISSION_DENIED",
          message: "Event is not allowed for this view.",
        });
      }
      if (message.kind === "invoke" || message.kind === "listen" || message.kind === "unlisten") {
        if (session.used.has(message.id))
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "Request ID was already used.",
          });
        if (
          session.used.size >= API_LIMITS.maxRequestIds ||
          session.pending.size >= API_LIMITS.maxPending ||
          (message.kind === "listen" &&
            session.subscriptions.size +
              [...session.pending.values()].filter((p) => p.kind === "listen").length >=
              API_LIMITS.maxSubscriptions)
        )
          throw new BunawayError({ code: "BUSY", message: "Request limit reached." });
        const duration =
          message.kind === "invoke" && message.deadline !== undefined
            ? Math.min(message.deadline - Date.now(), API_LIMITS.maxCommandDurationMs)
            : API_LIMITS.maxCommandDurationMs;
        if (duration <= 0)
          throw new BunawayError({ code: "TIMEOUT", message: "Request deadline passed." });
        session.used.add(message.id);
        session.pending.set(message.id, {
          kind: message.kind,
          expiry: performance.now() + duration,
          ...(message.kind === "listen" ? { event: message.event } : {}),
        });
        if (message.kind === "unlisten") session.subscriptions.delete(message.subscriptionId);
      } else if (message.kind === "cancel") {
        // Ignore repeated/unknown cancellations so Web input cannot flood reserved slots.
        if (!session.pending.delete(message.id)) return;
        this.error(message.id, { code: "CANCELLED", message: "Request cancelled." });
      }
      this.hooks.forward({
        kind: "client",
        route: session.route,
        message: message as ClientMessage,
      });
      this.hooks.log("web-message", { context: session.route.context, kind: message.kind });
    } catch (error) {
      this.hooks.log("web-message-rejected", {
        reason: error instanceof BunawayError ? error.code : "malformed",
      });
      this.error(
        id,
        error instanceof BunawayError
          ? { code: error.code, message: error.message }
          : { code: "INVALID_ARGUMENT", message: "Rejected Web message." },
      );
    }
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
  sameDocument(source: string) {
    if (this.session && this.policy.origins.includes(this.hooks.origin(source)))
      this.session.source = source;
  }
  revoke(reason: string) {
    this.generation++;
    const session = this.session;
    this.session = undefined;
    if (!session) return;
    this.hooks.forward({ kind: "revoke", route: session.route });
    this.hooks.log("revoke", { context: session.route.context, reason });
  }
  send(route: Route, message: ServerMessage) {
    if (!this.matches(route) || !this.session) {
      this.hooks.log("discarded", { reason: "inactive-context" });
      return;
    }
    const session = this.session;
    const text = serializeMessage(message);
    if (message.kind === "hello") {
      if (session.negotiated) throw new Error("Duplicate server hello");
      session.negotiated = true;
    } else if (message.kind === "result" || message.kind === "error") {
      const pending = session.pending.get(message.id);
      if (!pending) {
        this.hooks.log("discarded", { reason: "late-response", id: message.id });
        return;
      }
      if (performance.now() >= pending.expiry) {
        this.expire(message.id);
        return;
      }
      if (pending.kind === "listen" && message.kind === "result") {
        const value = message.payload as { subscriptionId?: unknown };
        if (!value || typeof value.subscriptionId !== "string" || Object.keys(value).length !== 1)
          throw new Error("Invalid subscription result");
        session.subscriptions.set(value.subscriptionId, {
          sequence: 0,
          event: pending.event ?? "",
        });
      }
      session.pending.delete(message.id);
    } else if (message.kind === "event") {
      const subscription = session.subscriptions.get(message.subscriptionId);
      if (!subscription) {
        this.hooks.log("discarded", { reason: "inactive-subscription" });
        return;
      }
      if (
        message.target !== this.policy.id ||
        message.event !== subscription.event ||
        message.sequence !== subscription.sequence + 1 ||
        !this.policy.events.includes(message.event)
      )
        throw new Error("Invalid event delivery");
      subscription.sequence = message.sequence;
    } else session.subscriptions.delete(message.subscriptionId);
    this.hooks.deliver(text);
    this.hooks.log("web-delivered", {
      context: route.context,
      kind: message.kind,
      ...("id" in message ? { id: message.id } : {}),
      ...(message.kind === "event" ? { name: message.event } : {}),
    });
  }
  private expire(id: string) {
    const session = this.session;
    if (!session?.pending.delete(id)) return;
    this.hooks.forward({
      kind: "client",
      route: session.route,
      message: { kind: "cancel", protocol: PROTOCOL_VERSION, id },
    });
    this.error(id, { code: "TIMEOUT", message: "Request deadline exceeded." });
    this.hooks.log("request-timeout", { id });
  }
  scanDeadlines() {
    for (const [id, pending] of this.session?.pending ?? [])
      if (performance.now() >= pending.expiry) this.expire(id);
  }
}

export function allowedHost(permissions: Policy["backend"], call: HostCall): boolean {
  try {
    parseHostCall(JSON.stringify(call));
  } catch {
    return false;
  }
  if (call.operation === "capabilities.get") return true;
  if (call.operation === "log.write") return permissions.log;
  const segments = call.payload.path.split("/");
  return permissions.storage.some((grant) => {
    const prefix = grant.pathPrefix ? grant.pathPrefix.split("/") : [];
    return (
      grant.scope === call.payload.scope &&
      grant.access.includes(call.operation === "storage.writeText" ? "write" : "read") &&
      prefix.every((part, index) => part === segments[index])
    );
  });
}
