import type { Hello, Message, ProcessFrame, WireError } from "./index.ts";
import { errorSchema } from "./schema.ts";
import { type JsonValue, validate } from "./validation.ts";

export type Dispose = () => void;
export type AsyncDispose = () => Promise<void>;
export type ClientMessage = Extract<
  Message,
  { kind: "hello" | "invoke" | "cancel" | "listen" | "unlisten" }
>;
export type ServerMessage = Extract<
  Message,
  { kind: "hello" | "result" | "error" | "event" | "subscription-error" }
>;
export type NegotiatedProtocol = Pick<Hello, "protocol" | "features" | "buildId">;
export type RuntimeIdentity = ProcessFrame["runtime"];

// Structural subset of the standard AbortSignal; portable packages need no DOM globals.
export interface CancellationSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

export interface CancellationController {
  readonly signal: CancellationSignal;
  abort(): void;
}

export type TransportEvent =
  | { kind: "message"; text: string }
  | { kind: "closed"; error?: WireError };

export interface Transport {
  // FIFO acceptance, not request completion. Queue overflow rejects with BUSY.
  send(text: string): Promise<void>;
  // Subscribe before the first send. A closed transport reports closure to late subscribers too.
  subscribe(listener: (event: TransportEvent) => void): Dispose;
  // Idempotent; completes when transport resources have been released.
  close(): Promise<void>;
}

export type CommandContract = { input: JsonValue; output: JsonValue };
export type CommandMap = Record<string, CommandContract>;
export type EventMap = Record<string, JsonValue>;

export const API_LIMITS = {
  handshakeTimeoutMs: 10000,
  shutdownTimeoutMs: 2000,
  maxCommandDurationMs: 30000,
  maxPending: 128,
  maxSubscriptions: 128,
  maxRequestIds: 1024,
} as const;

// A typing boundary, not a security token. Only the trusted runtime brands host-issued IDs.
declare const hostContext: unique symbol;
export type HostContext = string & { readonly [hostContext]: true };

export class BunawayError extends Error {
  readonly code: WireError["code"];
  readonly details?: WireError["details"];

  constructor(error: WireError) {
    const safe = validate(errorSchema, error);
    super(safe.message);
    this.name = "BunawayError";
    this.code = safe.code;
    if (safe.details !== undefined) this.details = safe.details;
  }
}
