import {
  MessagePort,
  receiveMessageOnPort,
  type Worker,
} from "node:worker_threads";
import type { ShutdownReason } from "@bunaway/core";
import {
  API_LIMITS,
  BunawayError,
  type ClientMessage,
  errorSchema,
  type HostCall,
  type HostContext,
  type HostResponse,
  type JsonValue,
  MAX_MESSAGE_BYTES,
  type NativeRegistration,
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

type Side = "main" | "ui" | "io" | "main-io" | "macos-main" | "macos-backend";
type Lane =
  | "native-event"
  | "data"
  | "approval"
  | "cancel"
  | "revoke"
  | "control"
  | "diagnostic"
  | "session-failure";
type FieldValidator<T> = (
  value: unknown,
  packet: Record<string, unknown>,
) => asserts value is T;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Worker packet");
  }
  return value as Record<string, unknown>;
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
    throw new Error("Invalid Worker identifier");
  }
}
function context(value: unknown): asserts value is HostContext {
  identifier(value);
}
function route(value: unknown): asserts value is Route {
  if (value === undefined) {
    throw new Error("Missing route");
  }
  const fields = record(value);
  if (Object.keys(fields).length !== 3) {
    throw new Error("Invalid route fields");
  }
  identifier(fields.viewId);
  context(fields.context);
  if (
    !Number.isSafeInteger(fields.documentGeneration) ||
    Number(fields.documentGeneration) < 0
  ) {
    throw new Error("Invalid document generation");
  }
}
function hostCall(value: unknown): asserts value is HostCall {
  parseHostCall(JSON.stringify(value));
}
function hostResponse(value: unknown): asserts value is HostResponse {
  parseHostResponse(JSON.stringify(value));
}
function authorization(value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error("Invalid authorization");
  }
}
function operationSource(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^(backend|view:[A-Za-z0-9_.:-]{1,128})$/.test(value)
  ) {
    throw new Error("Invalid operation source");
  }
}
function desktopAction(value: unknown): asserts value is "show" | "hide" {
  if (value !== "show" && value !== "hide") {
    throw new Error("Invalid desktop action");
  }
}
function quitReason(value: unknown): asserts value is "last-window" | "tray" {
  if (value !== "last-window" && value !== "tray") {
    throw new Error("Invalid quit reason");
  }
}
function shutdownReason(value: unknown): asserts value is ShutdownReason {
  if (
    value !== "last-window" &&
    value !== "tray" &&
    value !== "api" &&
    value !== "window-destroyed" &&
    value !== "session-end" &&
    value !== "interrupted"
  ) {
    throw new Error("Invalid shutdown reason");
  }
}
/** Flags of a Windows WM_ENDSESSION lParam; each is a distinct reason the OS gives for the session end. */
export type SessionEndFlags = {
  /** The user is logging off rather than shutting down or restarting. */
  logoff: boolean;
  /** The system is ending regardless of what applications do. */
  critical: boolean;
  /** Restart Manager asks the app to close so files can be updated. */
  closeApp: boolean;
};
function sessionEndFlags(value: unknown): asserts value is SessionEndFlags {
  const flags = record(value);
  if (
    Object.keys(flags).length !== 3 ||
    typeof flags.logoff !== "boolean" ||
    typeof flags.critical !== "boolean" ||
    typeof flags.closeApp !== "boolean"
  ) {
    throw new Error("Invalid session end flags");
  }
}
function sharedFlagBuffer(value: unknown): asserts value is SharedArrayBuffer {
  if (
    !(value instanceof SharedArrayBuffer) ||
    value.byteLength !== Int32Array.BYTES_PER_ELEMENT
  ) {
    throw new Error("Invalid shared release buffer");
  }
}
function wireError(value: unknown): asserts value is WireError {
  validateValue(errorSchema, value);
}
function jsonValue(value: unknown): asserts value is JsonValue {
  validateValue({}, value);
}
function diagnosticFields(
  value: unknown,
): asserts value is Record<string, unknown> {
  record(value);
}

/** Checks the nested Web contract without letting Worker direction substitute for Web direction. */
function webMessage(value: unknown, client: boolean): void {
  const message = parseMessage(JSON.stringify(value));
  const isClient = [
    "hello",
    "sdk-ready",
    "invoke",
    "listen",
    "unlisten",
    "cancel",
    "close",
  ].includes(message.kind);
  if (isClient !== client && message.kind !== "hello") {
    throw new Error("Invalid Web direction");
  }
}
function clientMessage(value: unknown): asserts value is ClientMessage {
  webMessage(value, true);
}
function serverMessage(value: unknown): asserts value is ServerMessage {
  webMessage(value, false);
}

/** Validates a bounded registration batch, allowing an empty batch only at completion. */
function nativeRegistrations(
  value: unknown,
  packet: Record<string, unknown>,
): asserts value is NativeRegistration[] {
  if (
    !Array.isArray(value) ||
    value.length > 1 ||
    typeof packet.complete !== "boolean" ||
    (!packet.complete && value.length === 0)
  ) {
    throw new Error("Invalid native registrations");
  }
  for (const plugin of value) {
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
  new NativeRegistry(value);
}
function registrationComplete(value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error("Invalid native registrations");
  }
}

function definePacket<Fields extends Record<string, FieldValidator<unknown>>>(
  fields: Fields,
  incoming: readonly Side[],
  lane: Lane,
) {
  return {
    fields,
    validators: Object.entries(fields),
    incoming,
    lane,
  };
}
const routedFields = {
  route,
};
const requestFields = {
  context,
  requestId: identifier,
};
const callFields = {
  ...requestFields,
  call: hostCall,
};
const approvalFields = {
  ...requestFields,
  allowed: authorization,
};
const responseFields = {
  ...requestFields,
  response: hostResponse,
};

/** Authoritative Worker contract: required fields and their types/validators, receiving sides, and queue lanes. */
const packetDefinitions = {
  "native-register": definePacket(
    {
      plugins: nativeRegistrations,
      /** Final batch commits the complete registry before backend setup can run. */
      complete: registrationComplete,
    },
    [
      "macos-main",
    ],
    "control",
  ),
  ready: definePacket(
    {},
    [
      "main",
      "main-io",
      "macos-main",
    ],
    "control",
  ),
  start: definePacket(
    {},
    [
      "ui",
    ],
    "control",
  ),
  shutdown: definePacket(
    {},
    [
      "ui",
      "io",
      "macos-backend",
    ],
    "control",
  ),
  /** The UI committed app shutdown without a quit veto; `reason` is the first cause. */
  closing: definePacket(
    {
      reason: shutdownReason,
    },
    [
      "main",
    ],
    "control",
  ),
  /**
   * Windows confirmed the session ends (WM_ENDSESSION). The UI thread blocks until the main thread
   * sets and notifies the first Int32 of `release` after app cleanup, or a timeout elapses.
   * Structured clone shares the buffer; the JSON size check sees it as an empty object.
   */
  "session-end": definePacket(
    {
      flags: sessionEndFlags,
      release: sharedFlagBuffer,
    },
    [
      "main",
    ],
    "control",
  ),
  /** The last live app window closed while the app stays resident. */
  "windows-empty": definePacket(
    {},
    [
      "main",
    ],
    "control",
  ),
  cleaned: definePacket(
    {},
    [
      "main",
      "main-io",
      "macos-main",
    ],
    "control",
  ),
  "desktop-control": definePacket(
    {
      action: desktopAction,
    },
    [
      "ui",
    ],
    "control",
  ),
  "quit-request": definePacket(
    {
      reason: quitReason,
    },
    [
      "main",
    ],
    "control",
  ),
  "quit-cancelled": definePacket(
    {},
    [
      "ui",
    ],
    "control",
  ),
  "session-open": definePacket(
    routedFields,
    [
      "main",
      "macos-backend",
    ],
    "data",
  ),
  revoke: definePacket(
    routedFields,
    [
      "main",
      "macos-backend",
    ],
    "revoke",
  ),
  client: definePacket(
    {
      ...routedFields,
      message: clientMessage,
    },
    [
      "main",
      "macos-backend",
    ],
    "data",
  ),
  "native-event": definePacket(
    {
      ...routedFields,
      event: identifier,
      payload: jsonValue,
    },
    [
      "main",
    ],
    "native-event",
  ),
  server: definePacket(
    {
      ...routedFields,
      message: serverMessage,
    },
    [
      "ui",
      "macos-main",
    ],
    "data",
  ),
  "session-failure": definePacket(
    {
      ...routedFields,
      error: wireError,
    },
    [
      "ui",
    ],
    "session-failure",
  ),
  "authorize-input": definePacket(
    callFields,
    [
      "ui",
      "main-io",
    ],
    "approval",
  ),
  "input-authorized": definePacket(
    approvalFields,
    [
      "main",
      "io",
    ],
    "approval",
  ),
  authorize: definePacket(
    callFields,
    [
      "ui",
    ],
    "approval",
  ),
  prepare: definePacket(
    callFields,
    [
      "main",
      "main-io",
    ],
    "approval",
  ),
  operation: definePacket(
    {
      ...callFields,
      source: operationSource,
    },
    [
      "ui",
      "io",
      "macos-main",
    ],
    "data",
  ),
  grant: definePacket(
    approvalFields,
    [
      "ui",
      "io",
    ],
    "approval",
  ),
  authorized: definePacket(
    approvalFields,
    [
      "main",
    ],
    "approval",
  ),
  cancel: definePacket(
    requestFields,
    [
      "ui",
      "io",
      "macos-main",
    ],
    "cancel",
  ),
  "cancel-context": definePacket(
    {
      context,
    },
    [
      "ui",
      "io",
    ],
    "revoke",
  ),
  "host-result": definePacket(
    responseFields,
    [
      "ui",
    ],
    "data",
  ),
  "host-response": definePacket(
    responseFields,
    [
      "main",
      "main-io",
      "macos-backend",
    ],
    "data",
  ),
  diagnostic: definePacket(
    {
      event: identifier,
      fields: diagnosticFields,
    },
    [
      "main",
    ],
    "diagnostic",
  ),
  fatal: definePacket(
    {
      error: wireError,
    },
    [
      "main",
      "main-io",
      "macos-main",
    ],
    "control",
  ),
};
type PacketDefinitions = typeof packetDefinitions;
type FieldValue<Validator> =
  Validator extends FieldValidator<infer Value> ? Value : never;
export type Packet = {
  [Kind in keyof PacketDefinitions]: {
    kind: Kind;
  } & {
    [Field in keyof PacketDefinitions[Kind]["fields"]]: FieldValue<
      PacketDefinitions[Kind]["fields"][Field]
    >;
  };
}[keyof PacketDefinitions];

function packetKind(value: unknown): value is Packet["kind"] {
  return typeof value === "string" && Object.hasOwn(packetDefinitions, value);
}

/** Validates a cloned packet against the receiving side, exact fields, size bound and nested protocol contracts; throws on rejection. */
export function validatePacket(value: unknown, incoming: Side): Packet {
  const packet = record(value);
  if (!packetKind(packet.kind)) {
    throw new Error("Invalid Worker direction");
  }
  const definition = packetDefinitions[packet.kind];
  if (!definition.incoming.includes(incoming)) {
    throw new Error("Invalid Worker direction");
  }
  // Worker envelopes add bounded transport metadata beyond the canonical protocol message.
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES + 1024) {
    throw new Error("Worker packet too large");
  }
  const fields = definition.validators;
  if (
    fields.some(([key]) => !Object.hasOwn(packet, key)) ||
    Object.keys(packet).some(
      (key) => key !== "kind" && !Object.hasOwn(definition.fields, key),
    )
  ) {
    throw new Error("Invalid Worker fields");
  }
  for (const [key, validate] of fields) {
    const validateField: FieldValidator<unknown> = validate;
    validateField(packet[key], packet);
  }
  // Every required field passed its validator, and the discriminator selects the inferred payload type.
  return packet as Packet;
}

// A broadcast can have one active send per subscription in every window.
// This is a bounded backlog policy, separate from unacknowledged data capacity.
const SERVER_QUEUE_LIMIT = MAX_WINDOWS * API_LIMITS.maxSubscriptions;
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
    /** Record cancellation or end an owned native modal loop only. Never dispatch operations, abort arbitrary listeners or release native resources. */
    private readonly observePolled?: (packet: Packet) => void,
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
      if (
        this.polling &&
        (packet.kind === "cancel" ||
          packet.kind === "cancel-context" ||
          packet.kind === "session-failure" ||
          packet.kind === "shutdown")
      ) {
        this.observePolled?.(packet);
      }
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
      if (!packetKind(packet.kind)) {
        throw new Error("Invalid Worker direction");
      }
      const lane: Lane =
        packet.kind === "client" && packet.message.kind === "cancel"
          ? "cancel"
          : packetDefinitions[packet.kind].lane;
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
