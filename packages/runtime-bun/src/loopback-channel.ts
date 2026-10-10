import {
  API_LIMITS,
  type ClientMessage,
  type HostContext,
  MAX_MESSAGE_BYTES,
  parseMessage,
  type ServerMessage,
  serializeMessage,
} from "@bunaway/protocol";
import type { Server, ServerWebSocket } from "bun";

type Lease = {
  context: HostContext;
  origin: string;
  token: string;
  live: boolean;
  claimed: boolean;
  helloSeen: boolean;
  queued: number;
  tail: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  socket?: ServerWebSocket<Lease>;
};

/**
 * Owns host-issued, single-use document connections on the IPv4 loopback interface.
 * The caller retains Core sessions and must revoke a lease before closing its session.
 * URLs are capabilities: deliver them only to the native-verified main document and never log them.
 */
export class LoopbackChannel {
  private readonly server: Server<Lease>;
  private readonly contexts = new Map<HostContext, Lease>();
  private readonly tokens = new Map<string, Lease>();
  private closed = false;
  private stopped: Promise<void> | undefined;

  constructor(
    private readonly hooks: {
      receive(context: HostContext, message: ClientMessage): Promise<void>;
      /** Synchronously starts owned session cleanup; invoked once on peer/protocol failure. */
      disconnected(context: HostContext, failed: boolean): void;
    },
  ) {
    this.server = Bun.serve<Lease>({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: MAX_MESSAGE_BYTES,
      fetch: (request, server) => {
        const url = new URL(request.url);
        const lease = this.tokens.get(url.pathname.slice(1));
        if (
          this.closed ||
          request.method !== "GET" ||
          url.search ||
          request.headers.get("host") !== `127.0.0.1:${server.port}` ||
          !lease?.live ||
          lease.claimed ||
          request.headers.get("origin") !== lease.origin
        ) {
          return new Response(null, {
            status: 403,
          });
        }
        // Claim before upgrading, so simultaneous handshakes cannot share a document.
        lease.claimed = true;
        this.tokens.delete(lease.token);
        if (
          server.upgrade(request, {
            data: lease,
          })
        ) {
          return;
        }
        this.disconnect(lease);
        return new Response(null, {
          status: 400,
        });
      },
      websocket: {
        maxPayloadLength: MAX_MESSAGE_BYTES,
        // Bound a stalled receiver independently of Core's pending command limit.
        backpressureLimit: 2 * MAX_MESSAGE_BYTES,
        closeOnBackpressureLimit: true,
        perMessageDeflate: false,
        idleTimeout: 0,
        open: (socket) => {
          const lease = socket.data;
          if (!lease.live) {
            socket.terminate();
            return;
          }
          lease.socket = socket;
          // SDK creation may happen later; only an unused connection grant expires here.
          clearTimeout(lease.timer);
        },
        message: (socket, input) => {
          const lease = socket.data;
          if (!lease.live) {
            return;
          }
          if (
            typeof input !== "string" ||
            lease.queued >= API_LIMITS.maxPending
          ) {
            this.disconnect(lease, true);
            return;
          }
          lease.queued++;
          // Preserve arrival order even when hello or session cleanup yields to other sockets.
          lease.tail = lease.tail
            .then(async () => {
              if (!lease.live) {
                return;
              }
              const message = parseMessage(input);
              switch (message.kind) {
                case "hello":
                  if (!lease.helloSeen) {
                    lease.helloSeen = true;
                  }
                  break;
                case "invoke":
                case "listen":
                case "unlisten":
                case "cancel":
                case "close":
                  if (!lease.helloSeen) {
                    throw new Error("Document hello required.");
                  }
                  break;
                default:
                  throw new Error("Invalid document direction.");
              }
              if (message.kind === "close") {
                this.disconnect(lease);
              } else {
                await this.hooks.receive(lease.context, message);
              }
            })
            .catch(() => this.disconnect(lease, true))
            .finally(() => {
              lease.queued--;
            });
        },
        // Bun can report a payload-limit disconnect as abnormal closure rather than 1009.
        close: (socket, code) =>
          this.disconnect(
            socket.data,
            code !== 1000 && code !== 1001 && code !== 1005,
          ),
      },
    });
  }

  /** Grants one live host context access from its actual, native-observed origin. */
  grant(context: HostContext, origin: string): string {
    if (this.closed || this.contexts.has(context)) {
      throw new Error("Document channel unavailable.");
    }
    if (this.contexts.size >= API_LIMITS.maxPending) {
      throw new Error("Document channel limit reached.");
    }
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || parsed.origin !== origin) {
      throw new Error("Invalid document origin.");
    }
    const token = crypto.randomUUID();
    const lease: Lease = {
      context,
      origin,
      token,
      live: true,
      claimed: false,
      helloSeen: false,
      queued: 0,
      tail: Promise.resolve(),
      timer: setTimeout(
        () => this.disconnect(lease),
        API_LIMITS.handshakeTimeoutMs,
      ),
    };
    this.contexts.set(context, lease);
    this.tokens.set(token, lease);
    return `ws://127.0.0.1:${this.server.port}/${token}`;
  }

  /** True includes an unconnected grant, so its responses cannot fall back to another transport. */
  owns(context: HostContext): boolean {
    return this.contexts.has(context);
  }

  /** Validates the outgoing message and fails closed if its document can no longer receive it. */
  send(context: HostContext, message: ServerMessage): void {
    const lease = this.contexts.get(context);
    if (
      !lease?.live ||
      !lease.socket ||
      lease.socket.send(serializeMessage(message)) === 0
    ) {
      if (lease) {
        this.disconnect(lease, true);
      }
      throw new Error("Document channel closed.");
    }
  }

  /** Invalidates a pending capability and terminates its socket without notifying the owner twice. */
  revoke(context: HostContext): void {
    const lease = this.contexts.get(context);
    if (!lease) {
      return;
    }
    lease.live = false;
    this.contexts.delete(context);
    this.tokens.delete(lease.token);
    clearTimeout(lease.timer);
    lease.socket?.terminate();
  }

  private disconnect(lease: Lease, failed = false): void {
    if (!lease.live) {
      return;
    }
    this.revoke(lease.context);
    this.hooks.disconnected(lease.context, failed);
  }

  /** Stops accepting connections and revokes all documents; the caller closes their Core sessions. */
  close(): Promise<void> {
    if (this.stopped) {
      return this.stopped;
    }
    this.closed = true;
    for (const context of this.contexts.keys()) {
      this.revoke(context);
    }
    this.stopped = this.server.stop(true);
    return this.stopped;
  }
}
