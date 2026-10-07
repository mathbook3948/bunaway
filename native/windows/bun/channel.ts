import type { MessagePort, Worker } from "node:worker_threads";
import {
  API_LIMITS,
  type ClientMessage,
  errorSchema,
  type HostCall,
  type HostContext,
  type HostResponse,
  MAX_MESSAGE_BYTES,
  type NativeRegistration,
  type Policy,
  parseHostCall,
  parseHostResponse,
  parseMessage,
  type RuntimeIdentity,
  type ServerMessage,
  validateValue,
  type WireError,
} from "../../../packages/protocol/src/index.ts";

export type Route = { viewId: string; documentGeneration: number; context: HostContext };
export const MAX_WINDOWS = 128;
export type WindowSpec = {
  view: string;
  home: string;
  title: string;
  window: { width: number; height: number };
};
export type UIConfig = {
  runtime: RuntimeIdentity;
  policy: Policy;
  backendContext: HostContext;
  windows: WindowSpec[];
  assets: string;
  dataRoot: string;
  loader: string;
  legacyProfile?: boolean;
  plugins?: NativeRegistration[];
  devtools?: boolean;
};
export type Packet =
  | { kind: "ready" | "start" | "shutdown" | "closing" | "cleaned" }
  | { kind: "session-open" | "revoke"; route: Route }
  | { kind: "client"; route: Route; message: ClientMessage }
  | { kind: "server"; route: Route; message: ServerMessage }
  | { kind: "authorize"; context: HostContext; requestId: string; call: HostCall }
  | { kind: "prepare"; context: HostContext; requestId: string; call: HostCall }
  | { kind: "operation"; context: HostContext; requestId: string; call: HostCall; source: string }
  | { kind: "grant"; context: HostContext; requestId: string; allowed: boolean }
  | { kind: "authorized"; context: HostContext; requestId: string; allowed: boolean }
  | { kind: "cancel"; context: HostContext; requestId: string }
  | { kind: "cancel-context"; context: HostContext }
  | {
      kind: "host-result" | "host-response";
      context: HostContext;
      requestId: string;
      response: HostResponse;
    }
  | { kind: "diagnostic"; event: string; fields: Record<string, unknown> }
  | { kind: "fatal"; error: WireError };

const uiKinds = [
  "ready",
  "session-open",
  "revoke",
  "client",
  "closing",
  "authorized",
  "prepare",
  "host-response",
  "cleaned",
  "fatal",
  "diagnostic",
];
const mainKinds = [
  "operation",
  "start",
  "server",
  "authorize",
  "grant",
  "cancel",
  "cancel-context",
  "host-result",
  "shutdown",
];
const ioKinds = ["ready", "prepare", "host-response", "cleaned", "fatal"];
const ioMainKinds = ["operation", "grant", "cancel", "cancel-context", "shutdown"];
type Side = "main" | "ui" | "io" | "main-io";
const controlKinds = new Set(["start", "shutdown", "closing", "cleaned", "fatal", "ready"]);
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Worker packet");
  return value as Record<string, unknown>;
}
function identifier(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value))
    throw new Error("Invalid Worker identifier");
}
export function validatePacket(value: unknown, incoming: Side): Packet {
  const packet = record(value);
  const allowed = { main: uiKinds, ui: mainKinds, io: ioMainKinds, "main-io": ioKinds }[incoming];
  if (typeof packet.kind !== "string" || !allowed.includes(packet.kind))
    throw new Error("Invalid Worker direction");
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES + 1024)
    throw new Error("Worker packet too large");
  const fields: Record<string, string[]> = {
    ready: [],
    start: [],
    shutdown: [],
    closing: [],
    cleaned: [],
    "session-open": ["route"],
    revoke: ["route"],
    client: ["route", "message"],
    server: ["route", "message"],
    authorize: ["context", "requestId", "call"],
    prepare: ["context", "requestId", "call"],
    operation: ["context", "requestId", "call", "source"],
    authorized: ["context", "requestId", "allowed"],
    grant: ["context", "requestId", "allowed"],
    cancel: ["context", "requestId"],
    "cancel-context": ["context"],
    "host-result": ["context", "requestId", "response"],
    "host-response": ["context", "requestId", "response"],
    diagnostic: ["event", "fields"],
    fatal: ["error"],
  };
  const required = fields[packet.kind];
  if (
    !required ||
    required.some((key) => !Object.hasOwn(packet, key)) ||
    Object.keys(packet).some((key) => key !== "kind" && !required.includes(key))
  )
    throw new Error("Invalid Worker fields");
  if (packet.route !== undefined) {
    const route = record(packet.route);
    if (Object.keys(route).length !== 3) throw new Error("Invalid route fields");
    identifier(route.viewId);
    identifier(route.context);
    if (!Number.isSafeInteger(route.documentGeneration) || Number(route.documentGeneration) < 0)
      throw new Error("Invalid document generation");
  }
  if (["session-open", "revoke", "client", "server"].includes(packet.kind) && !packet.route)
    throw new Error("Missing route");
  if (packet.context !== undefined) identifier(packet.context);
  if (packet.kind === "cancel-context") identifier(packet.context);
  if (packet.requestId !== undefined) identifier(packet.requestId);
  if (
    [
      "authorize",
      "authorized",
      "cancel",
      "host-result",
      "host-response",
      "operation",
      "prepare",
      "grant",
    ].includes(packet.kind)
  ) {
    identifier(packet.context);
    identifier(packet.requestId);
  }
  if (packet.kind === "client" || packet.kind === "server") {
    const message = parseMessage(JSON.stringify(packet.message));
    const client = ["hello", "invoke", "listen", "unlisten", "cancel"].includes(message.kind);
    if (client !== (packet.kind === "client") && message.kind !== "hello")
      throw new Error("Invalid Web direction");
  }
  if (["authorize", "operation", "prepare"].includes(packet.kind))
    parseHostCall(JSON.stringify(packet.call));
  if (["authorized", "grant"].includes(packet.kind) && typeof packet.allowed !== "boolean")
    throw new Error("Invalid authorization");
  if (
    packet.kind === "operation" &&
    (typeof packet.source !== "string" ||
      !/^(backend|view:[A-Za-z0-9_.:-]{1,128})$/.test(packet.source))
  )
    throw new Error("Invalid operation source");
  if (packet.kind === "host-result" || packet.kind === "host-response")
    parseHostResponse(JSON.stringify(packet.response));
  if (packet.kind === "diagnostic") {
    identifier(packet.event);
    record(packet.fields);
  }
  if (packet.kind === "fatal") validateValue(errorSchema, packet.error);
  return packet as Packet;
}

// Bounded unacknowledged structured-clone messages; ack means acceptance, not command completion.
export class Channel {
  private sequence = 0;
  private expected = 1;
  private closed = false;
  private droppedDiagnostics = 0;
  private readonly pending = new Map<
    number,
    {
      lane: "data" | "cancel" | "revoke" | "control" | "diagnostic";
      resolve(): void;
      reject(error: Error): void;
    }
  >();
  constructor(
    private readonly port: Pick<MessagePort | Worker, "postMessage" | "on" | "off">,
    private readonly runtime: RuntimeIdentity,
    private readonly side: Side,
    private readonly receive: (packet: Packet) => void | Promise<void>,
    private readonly fail: (error: unknown) => void,
  ) {
    port.on("message", this.accept);
  }

  private accept = (raw: unknown) => {
    try {
      const envelope = record(raw);
      const runtime = record(envelope.runtime);
      if (Object.keys(runtime).length !== 2) throw new Error("Invalid runtime fields");
      if (runtime.id !== this.runtime.id || runtime.generation !== this.runtime.generation)
        throw new Error("Stale Worker runtime");
      if (envelope.ack !== undefined) {
        if (!Number.isSafeInteger(envelope.ack) || Number(envelope.ack) < 1)
          throw new Error("Invalid Worker ack id");
        const pending = this.pending.get(Number(envelope.ack));
        if (!pending || Object.keys(envelope).length !== 2) throw new Error("Invalid Worker ack");
        this.pending.delete(Number(envelope.ack));
        pending.resolve();
        return;
      }
      if (
        this.closed ||
        envelope.sequence !== this.expected++ ||
        Object.keys(envelope).length !== 3
      )
        throw new Error("Invalid Worker envelope");
      const packet = validatePacket(envelope.packet, this.side);
      // Dispatch without waiting on application work, keeping setup Host API replies live.
      Promise.resolve(this.receive(packet))
        .then(() => {
          this.port.postMessage({ runtime: this.runtime, ack: envelope.sequence }, []);
        })
        .catch(this.fail);
    } catch (error) {
      this.fail(error);
    }
  };

  send(packet: Packet): Promise<void> {
    try {
      if (this.closed) throw new Error("Worker channel closed");
      const opposite: Side = { main: "ui", ui: "main", io: "main-io", "main-io": "io" }[
        this.side
      ] as Side;
      const lane =
        packet.kind === "diagnostic"
          ? "diagnostic"
          : packet.kind === "cancel" ||
              (packet.kind === "client" && packet.message.kind === "cancel")
            ? "cancel"
            : packet.kind === "revoke" || packet.kind === "cancel-context"
              ? "revoke"
              : controlKinds.has(packet.kind)
                ? "control"
                : "data";
      const count = [...this.pending.values()].filter((item) => item.lane === lane).length;
      if (packet.kind === "diagnostic" && count >= 16) {
        // Diagnostics must not consume request/control capacity or turn BUSY into app failure.
        // Report suppressed entries when the receiver next has room, without another queue.
        this.droppedDiagnostics++;
        return Promise.resolve();
      }
      if (packet.kind === "diagnostic" && this.droppedDiagnostics) {
        packet = {
          ...packet,
          fields: { ...packet.fields, droppedDiagnostics: this.droppedDiagnostics },
        };
        this.droppedDiagnostics = 0;
      }
      validatePacket(packet, opposite);
      // Cancelling all requests or revoking all views leaves lifecycle control slots free.
      const limit =
        lane === "revoke"
          ? MAX_WINDOWS
          : lane === "data" || lane === "cancel"
            ? API_LIMITS.maxPending
            : 16;
      if (count >= limit) throw new Error("Worker channel full");
      const sequence = ++this.sequence;
      return new Promise((resolve, reject) => {
        this.pending.set(sequence, { lane, resolve, reject });
        try {
          this.port.postMessage({ runtime: this.runtime, sequence, packet }, []);
        } catch (error) {
          this.pending.delete(sequence);
          reject(error);
        }
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }
  notify(packet: Packet) {
    void this.send(packet).catch(this.fail);
  }
  canSend(count = 1, pendingRequests = 0) {
    return (
      [...this.pending.values()].filter((item) => item.lane === "data").length + count <=
        API_LIMITS.maxPending &&
      // A request keeps its cancellation slot until completion or cancellation ack.
      pendingRequests +
        [...this.pending.values()].filter((item) => item.lane === "cancel").length +
        count <=
        API_LIMITS.maxPending
    );
  }
  async drain() {
    const deadline = Date.now() + 10000;
    while (this.pending.size) {
      if (Date.now() > deadline) throw new Error("Worker channel drain timed out");
      await Bun.sleep(1);
    }
  }
  close() {
    this.closed = true;
    this.port.off("message", this.accept);
    for (const pending of this.pending.values()) pending.reject(new Error("Worker channel closed"));
    this.pending.clear();
  }
}
