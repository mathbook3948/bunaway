import {
  MessagePort,
  receiveMessageOnPort,
  type Worker,
} from "node:worker_threads";
import {
  API_LIMITS,
  BunawayError,
  type ClientMessage,
  errorSchema,
  type HostCall,
  type HostContext,
  type HostResponse,
  MAX_MESSAGE_BYTES,
  NativeRegistry,
  parseHostCall,
  parseHostResponse,
  parseMessage,
  type RuntimeIdentity,
  type ServerMessage,
  validateValue,
  type WireError,
} from "@bunaway/protocol";

import { MAX_WINDOWS } from "./window-config.ts";

export type Route = {
  viewId: string;
  documentGeneration: number;
  context: HostContext;
};
export {
  MAX_WINDOWS,
  type WindowSpec,
} from "./window-config.ts";
export type Packet =
  | {
      kind: "native-register";
      plugins: import("@bunaway/protocol").NativeRegistration[];
      /** Final batch commits the complete registry before backend setup can run. */
      complete: boolean;
    }
  | {
      kind: "ready" | "start" | "shutdown" | "closing" | "cleaned";
    }
  | {
      kind: "desktop-control";
      action: "show" | "hide";
    }
  | {
      kind: "quit-request";
      reason: "last-window" | "tray";
    }
  | {
      kind: "quit-cancelled";
    }
  | {
      kind: "session-open" | "revoke";
      route: Route;
    }
  | {
      kind: "client";
      route: Route;
      message: ClientMessage;
    }
  | {
      kind: "native-event";
      route: Route;
      event: string;
      payload: import("@bunaway/protocol").JsonValue;
    }
  | {
      kind: "server";
      route: Route;
      message: ServerMessage;
    }
  | {
      kind: "session-failure";
      route: Route;
      error: WireError;
    }
  | {
      kind: "authorize";
      context: HostContext;
      requestId: string;
      call: HostCall;
    }
  | {
      kind: "prepare";
      context: HostContext;
      requestId: string;
      call: HostCall;
    }
  | {
      kind: "operation";
      context: HostContext;
      requestId: string;
      call: HostCall;
      source: string;
    }
  | {
      kind: "grant";
      context: HostContext;
      requestId: string;
      allowed: boolean;
    }
  | {
      kind: "authorized";
      context: HostContext;
      requestId: string;
      allowed: boolean;
    }
  | {
      kind: "cancel";
      context: HostContext;
      requestId: string;
    }
  | {
      kind: "cancel-context";
      context: HostContext;
    }
  | {
      kind: "host-result" | "host-response";
      context: HostContext;
      requestId: string;
      response: HostResponse;
    }
  | {
      kind: "diagnostic";
      event: string;
      fields: Record<string, unknown>;
    }
  | {
      kind: "fatal";
      error: WireError;
    };

const uiKinds = [
  "native-event",
  "ready",
  "session-open",
  "revoke",
  "client",
  "closing",
  "quit-request",
  "authorized",
  "prepare",
  "host-response",
  "cleaned",
  "fatal",
  "diagnostic",
];
const mainKinds = [
  "operation",
  "desktop-control",
  "quit-cancelled",
  "start",
  "server",
  "session-failure",
  "authorize",
  "grant",
  "cancel",
  "cancel-context",
  "host-result",
  "shutdown",
];
const ioKinds = [
  "ready",
  "prepare",
  "host-response",
  "cleaned",
  "fatal",
];
const ioMainKinds = [
  "operation",
  "grant",
  "cancel",
  "cancel-context",
  "shutdown",
];
type Side = "main" | "ui" | "io" | "main-io" | "macos-main" | "macos-backend";
const macosMainKinds = [
  "native-register",
  "operation",
  "cancel",
  "ready",
  "cleaned",
  "server",
  "fatal",
];
const macosBackendKinds = [
  "host-response",
  "session-open",
  "revoke",
  "client",
  "shutdown",
];
const controlKinds = new Set([
  "native-register",
  "desktop-control",
  "quit-cancelled",
  "quit-request",
  "start",
  "shutdown",
  "closing",
  "cleaned",
  "fatal",
  "ready",
]);
const approvalKinds = new Set([
  "prepare",
  "authorize",
  "authorized",
  "grant",
]);
const requiredFields: Record<Packet["kind"], readonly string[]> = {
  "native-event": [
    "route",
    "event",
    "payload",
  ],
  "native-register": [
    "plugins",
    "complete",
  ],
  "desktop-control": [
    "action",
  ],
  "quit-request": [
    "reason",
  ],
  "quit-cancelled": [],
  ready: [],
  start: [],
  shutdown: [],
  closing: [],
  cleaned: [],
  "session-open": [
    "route",
  ],
  revoke: [
    "route",
  ],
  client: [
    "route",
    "message",
  ],
  server: [
    "route",
    "message",
  ],
  "session-failure": [
    "route",
    "error",
  ],
  authorize: [
    "context",
    "requestId",
    "call",
  ],
  prepare: [
    "context",
    "requestId",
    "call",
  ],
  operation: [
    "context",
    "requestId",
    "call",
    "source",
  ],
  authorized: [
    "context",
    "requestId",
    "allowed",
  ],
  grant: [
    "context",
    "requestId",
    "allowed",
  ],
  cancel: [
    "context",
    "requestId",
  ],
  "cancel-context": [
    "context",
  ],
  "host-result": [
    "context",
    "requestId",
    "response",
  ],
  "host-response": [
    "context",
    "requestId",
    "response",
  ],
  diagnostic: [
    "event",
    "fields",
  ],
  fatal: [
    "error",
  ],
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Worker packet");
  }
  return value as Record<string, unknown>;
}
function packetKind(value: unknown): value is Packet["kind"] {
  return typeof value === "string" && Object.hasOwn(requiredFields, value);
}
function identifier(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
    throw new Error("Invalid Worker identifier");
  }
}

/** Validates a cloned packet against the receiving side, exact fields, size bound and nested protocol contracts; throws on rejection. */
export function validatePacket(value: unknown, incoming: Side): Packet {
  const packet = record(value);
  const allowed = {
    main: uiKinds,
    ui: mainKinds,
    io: ioMainKinds,
    "main-io": ioKinds,
    "macos-main": macosMainKinds,
    "macos-backend": macosBackendKinds,
  }[incoming];
  if (!packetKind(packet.kind) || !allowed.includes(packet.kind)) {
    throw new Error("Invalid Worker direction");
  }
  // Worker envelopes add bounded transport metadata beyond the canonical protocol message.
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES + 1024) {
    throw new Error("Worker packet too large");
  }
  const required = requiredFields[packet.kind];
  if (
    !required ||
    required.some((key) => !Object.hasOwn(packet, key)) ||
    Object.keys(packet).some((key) => key !== "kind" && !required.includes(key))
  ) {
    throw new Error("Invalid Worker fields");
  }
  if (
    packet.kind === "desktop-control" &&
    (typeof packet.action !== "string" ||
      ![
        "show",
        "hide",
      ].includes(packet.action))
  ) {
    throw new Error("Invalid desktop action");
  }
  if (
    packet.kind === "quit-request" &&
    (typeof packet.reason !== "string" ||
      ![
        "last-window",
        "tray",
      ].includes(packet.reason))
  ) {
    throw new Error("Invalid quit reason");
  }
  if (packet.kind === "native-register") {
    if (
      !Array.isArray(packet.plugins) ||
      packet.plugins.length > 1 ||
      typeof packet.complete !== "boolean" ||
      (!packet.complete && packet.plugins.length === 0)
    ) {
      throw new Error("Invalid native registrations");
    }
    for (const plugin of packet.plugins) {
      const registration = record(plugin);
      if (
        Object.keys(registration).length !== 3 ||
        typeof registration.name !== "string" ||
        typeof registration.version !== "string" ||
        !registration.native
      ) {
        throw new Error("Invalid native registration fields");
      }
    }
    new NativeRegistry(packet.plugins);
  }
  if (packet.route !== undefined) {
    const route = record(packet.route);
    if (Object.keys(route).length !== 3) {
      throw new Error("Invalid route fields");
    }
    identifier(route.viewId);
    identifier(route.context);
    if (
      !Number.isSafeInteger(route.documentGeneration) ||
      Number(route.documentGeneration) < 0
    ) {
      throw new Error("Invalid document generation");
    }
  }
  if (
    [
      "session-open",
      "revoke",
      "client",
      "server",
      "session-failure",
      "native-event",
    ].includes(packet.kind) &&
    !packet.route
  ) {
    throw new Error("Missing route");
  }
  if (packet.context !== undefined) {
    identifier(packet.context);
  }
  if (packet.kind === "cancel-context") {
    identifier(packet.context);
  }
  if (packet.requestId !== undefined) {
    identifier(packet.requestId);
  }
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
    const client = [
      "hello",
      "sdk-ready",
      "invoke",
      "listen",
      "unlisten",
      "cancel",
      "close",
    ].includes(message.kind);
    if (client !== (packet.kind === "client") && message.kind !== "hello") {
      throw new Error("Invalid Web direction");
    }
  }
  if (
    [
      "authorize",
      "operation",
      "prepare",
    ].includes(packet.kind)
  ) {
    parseHostCall(JSON.stringify(packet.call));
  }
  if (
    [
      "authorized",
      "grant",
    ].includes(packet.kind) &&
    typeof packet.allowed !== "boolean"
  ) {
    throw new Error("Invalid authorization");
  }
  if (
    packet.kind === "operation" &&
    (typeof packet.source !== "string" ||
      !/^(backend|view:[A-Za-z0-9_.:-]{1,128})$/.test(packet.source))
  ) {
    throw new Error("Invalid operation source");
  }
  if (packet.kind === "host-result" || packet.kind === "host-response") {
    parseHostResponse(JSON.stringify(packet.response));
  }
  if (packet.kind === "diagnostic") {
    identifier(packet.event);
    record(packet.fields);
  }
  if (packet.kind === "native-event") {
    identifier(packet.event);
    validateValue({}, packet.payload);
  }
  if (packet.kind === "fatal" || packet.kind === "session-failure") {
    validateValue(errorSchema, packet.error);
  }
  return packet as Packet;
}

// A broadcast can have one active send per subscription in every window.
// This is a bounded backlog policy, separate from unacknowledged data capacity.
const SERVER_QUEUE_LIMIT = MAX_WINDOWS * API_LIMITS.maxSubscriptions;
type Lane =
  | "native-event"
  | "data"
  | "approval"
  | "cancel"
  | "revoke"
  | "control"
  | "diagnostic"
  | "session-failure";
type QueuedData = {
  packet: Extract<
    Packet,
    {
      kind: "server" | "host-result" | "host-response";
    }
  >;
  resolve(): void;
  reject(error: unknown): void;
};

/** Owns Worker message validation, bounded queues, acknowledgements, and listener cleanup. An ack means acceptance, not command completion. */
export class Channel {
  private sequence = 0;
  private expected = 1;
  private closed = false;
  private polling = false;
  private droppedDiagnostics = 0;
  private readonly queuedData = new Set<QueuedData>();
  private queuedServerCount = 0;
  private queuedCompletions = 0;
  private readonly pending = new Map<
    number,
    {
      lane: Lane;
      resolve(): void;
      reject(error: Error): void;
    }
  >();
  constructor(
    private readonly port: Pick<
      MessagePort | Worker,
      "postMessage" | "on" | "off"
    >,
    private readonly runtime: RuntimeIdentity,
    private readonly side: Side,
    private readonly receive: (packet: Packet) => void | Promise<void>,
    private readonly fail: (error: unknown) => void,
  ) {
    port.on("message", this.accept);
  }

  /** Validates runtime and sequence identity before dispatch, then acknowledges only after the receive callback settles. */
  private accept = (raw: unknown) => {
    try {
      const envelope = record(raw);
      const runtime = record(envelope.runtime);
      if (Object.keys(runtime).length !== 2) {
        throw new Error("Invalid runtime fields");
      }
      // The boot UUID keeps packets from another app run from matching this channel.
      if (
        runtime.id !== this.runtime.id ||
        runtime.generation !== this.runtime.generation
      ) {
        throw new Error("Stale Worker runtime");
      }
      if (envelope.ack !== undefined) {
        if (!Number.isSafeInteger(envelope.ack) || Number(envelope.ack) < 1) {
          throw new Error("Invalid Worker ack id");
        }
        const pending = this.pending.get(Number(envelope.ack));
        if (!pending || Object.keys(envelope).length !== 2) {
          throw new Error("Invalid Worker ack");
        }
        this.pending.delete(Number(envelope.ack));
        // Retained traffic owns the released slot before new requests.
        this.pumpData();
        pending.resolve();
        return;
      }
      if (
        this.closed ||
        envelope.sequence !== this.expected++ ||
        Object.keys(envelope).length !== 3
      ) {
        throw new Error("Invalid Worker envelope");
      }
      const packet = validatePacket(envelope.packet, this.side);
      // Dispatch without waiting on application work, keeping setup Host API replies live.
      const acknowledge = () => {
        this.port.postMessage(
          {
            runtime: this.runtime,
            ack: envelope.sequence,
          },
          [],
        );
      };
      // Resource changes must not re-enter a Win32/COM callback while polling its acknowledgements.
      const completion =
        this.polling && packet.kind !== "server"
          ? Promise.resolve().then(() => this.receive(packet))
          : this.receive(packet);
      // Native modal loops cannot run Promise jobs. Completed synchronous deliveries release capacity now.
      // A void callback may return an ignored value, such as Array.push's count.
      if (completion && typeof completion.then === "function") {
        void Promise.resolve(completion).then(acknowledge).catch(this.fail);
      } else {
        acknowledge();
      }
    } catch (error) {
      this.fail(error);
    }
  };

  /** Process a bounded MessagePort batch inside native callbacks. Acks and server delivery run now; other handlers wait for JS to resume. Nested polls are ignored. */
  poll(): void {
    if (this.closed || this.polling) {
      return;
    }
    if (!(this.port instanceof MessagePort)) {
      throw new Error("Worker channel polling requires a MessagePort.");
    }
    this.polling = true;
    try {
      for (
        let count = 0;
        count < API_LIMITS.maxPending && !this.closed;
        count++
      ) {
        const received = receiveMessageOnPort(this.port);
        if (!received) {
          break;
        }
        this.accept(received.message);
      }
    } finally {
      this.polling = false;
    }
  }

  /** Resolves on peer acknowledgement; server and Host responses wait in a bounded FIFO. Rejects invalid or over-capacity sends. */
  send(packet: Packet): Promise<void> {
    try {
      if (this.closed) {
        throw new Error("Worker channel closed");
      }
      const opposite: Side = {
        main: "ui",
        ui: "main",
        io: "main-io",
        "main-io": "io",
        "macos-main": "macos-backend",
        "macos-backend": "macos-main",
      }[this.side] as Side;
      let lane: Lane =
        packet.kind === "diagnostic"
          ? "diagnostic"
          : packet.kind === "session-failure"
            ? "session-failure"
            : packet.kind === "cancel" ||
                (packet.kind === "client" && packet.message.kind === "cancel")
              ? "cancel"
              : packet.kind === "revoke" || packet.kind === "cancel-context"
                ? "revoke"
                : approvalKinds.has(packet.kind)
                  ? "approval"
                  : controlKinds.has(packet.kind)
                    ? "control"
                    : "data";
      if (packet.kind === "native-event") {
        lane = "native-event";
      }
      const count = [
        ...this.pending.values(),
      ].filter((item) => item.lane === lane).length;
      if (packet.kind === "diagnostic" && count >= 16) {
        // Diagnostics must not consume request/control capacity or turn BUSY into app failure.
        // Report suppressed entries when the receiver next has room, without another queue.
        this.droppedDiagnostics++;
        return Promise.resolve();
      }
      if (packet.kind === "diagnostic" && this.droppedDiagnostics) {
        packet = {
          ...packet,
          fields: {
            ...packet.fields,
            droppedDiagnostics: this.droppedDiagnostics,
          },
        };
        this.droppedDiagnostics = 0;
      }
      validatePacket(packet, opposite);
      // A full request burst must still leave room for approvals, cancellation and shutdown.
      const limit =
        lane === "revoke" || lane === "session-failure"
          ? MAX_WINDOWS
          : lane === "data" ||
              lane === "approval" ||
              lane === "cancel" ||
              lane === "native-event"
            ? API_LIMITS.maxPending
            : 16;
      if (
        packet.kind === "server" ||
        packet.kind === "host-result" ||
        packet.kind === "host-response"
      ) {
        if (
          packet.kind === "server" &&
          this.queuedServerCount >= SERVER_QUEUE_LIMIT
        ) {
          throw new BunawayError({
            code: "BUSY",
            message: "Server message queue full.",
          });
        }
        if (
          packet.kind !== "server" &&
          this.queuedCompletions >= API_LIMITS.maxPending
        ) {
          throw new Error("Host response queue full");
        }
        const retained = packet;
        return new Promise((resolve, reject) => {
          this.queuedData.add({
            packet: retained,
            resolve,
            reject,
          });
          if (retained.kind === "server") {
            this.queuedServerCount++;
          } else {
            this.queuedCompletions++;
          }
          this.pumpData();
        });
      }
      if (count >= limit) {
        if (lane === "native-event") {
          throw new BunawayError({
            code: "BUSY",
            message: "Native event queue full.",
          });
        }
        throw new Error("Worker channel full");
      }
      return this.post(packet, lane);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private post(packet: Packet, lane: Lane): Promise<void> {
    const sequence = ++this.sequence;
    return new Promise((resolve, reject) => {
      // Register first so an immediate acknowledgement has a waiter; undo it if posting fails synchronously.
      this.pending.set(sequence, {
        lane,
        resolve,
        reject,
      });
      try {
        this.port.postMessage(
          {
            runtime: this.runtime,
            sequence,
            packet,
          },
          [],
        );
      } catch (error) {
        this.pending.delete(sequence);
        reject(error);
      }
    });
  }

  private pumpData(): void {
    if (this.closed || this.queuedData.size === 0) {
      return;
    }
    let count = 0;
    for (const item of this.pending.values()) {
      if (item.lane === "data") {
        count++;
      }
    }
    while (!this.closed && count < API_LIMITS.maxPending) {
      const queued = this.queuedData.values().next().value;
      if (!queued) {
        return;
      }
      this.removeQueued(queued);
      void this.post(queued.packet, "data").then(queued.resolve, queued.reject);
      count++;
    }
  }

  private removeQueued(queued: QueuedData): void {
    this.queuedData.delete(queued);
    if (queued.packet.kind === "server") {
      this.queuedServerCount--;
    } else {
      this.queuedCompletions--;
    }
  }

  /** Drops only queued server messages for a revoked context and settles their send promises. */
  discardServers(context: HostContext): void {
    for (const queued of this.queuedData) {
      if (
        queued.packet.kind === "server" &&
        queued.packet.route.context === context
      ) {
        this.removeQueued(queued);
        queued.resolve();
      }
    }
  }
  /** Sends without a caller-owned promise and routes failures to the channel's failure handler. */
  notify(packet: Packet) {
    void this.send(packet).catch(this.fail);
  }

  /** Checks requested data slots and reserves room for pending requests' cancellation or approval traffic. */
  canSend(count = 1, pendingRequests = 0) {
    return (
      !this.closed &&
      this.queuedData.size === 0 &&
      [
        ...this.pending.values(),
      ].filter((item) => item.lane === "data").length +
        count <=
        API_LIMITS.maxPending &&
      // Reserve room until cancellation and approval acknowledgements also arrive.
      pendingRequests +
        [
          ...this.pending.values(),
        ].filter((item) => item.lane === "cancel" || item.lane === "approval")
          .length +
        count <=
        API_LIMITS.maxPending
    );
  }

  /** Waits for all queued sends and acknowledgements, failing if they do not drain within ten seconds. */
  async drain() {
    const deadline = Date.now() + 10000;
    while (this.pending.size || this.queuedData.size) {
      if (Date.now() > deadline) {
        throw new Error("Worker channel drain timed out");
      }
      await Bun.sleep(1);
    }
  }

  /** Removes the listener and rejects all in-flight and queued send promises. */
  close() {
    this.closed = true;
    this.port.off("message", this.accept);
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Worker channel closed"));
    }
    this.pending.clear();
    for (const queued of this.queuedData) {
      queued.reject(new Error("Worker channel closed"));
    }
    this.queuedData.clear();
    this.queuedServerCount = 0;
    this.queuedCompletions = 0;
  }
}
