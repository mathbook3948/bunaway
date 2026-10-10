import type { Hello, Message, ProcessFrame, WireError } from "./index.ts";
import { errorSchema } from "./schema.ts";
import { type JsonValue, validate } from "./validation.ts";

export type Dispose = () => void;
export type AsyncDispose = () => Promise<void>;
export type ClientMessage = Extract<
  Message,
  {
    kind:
      | "hello"
      | "sdk-ready"
      | "invoke"
      | "cancel"
      | "listen"
      | "unlisten"
      | "close";
  }
>;
export type ServerMessage = Extract<
  Message,
  {
    kind: "hello" | "result" | "error" | "event" | "subscription-error";
  }
>;
export type NegotiatedProtocol = Pick<
  Hello,
  "protocol" | "features" | "buildId"
>;
export type RuntimeIdentity = ProcessFrame["runtime"];

/** Structural subset of AbortSignal that keeps portable packages independent of DOM globals. */
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
  | {
      kind: "message";
      text: string;
    }
  | {
      kind: "closed";
      error?: WireError;
    };

export interface Transport {
  /** Resolves when the transport accepts a frame; request completion arrives separately. */
  send(text: string): Promise<void>;
  /** Subscribe before sending; late subscribers also receive a closed transport event. */
  subscribe(listener: (event: TransportEvent) => void): Dispose;
  /** Closes idempotently and completes after transport resources are released. */
  close(): Promise<void>;
}

/** JSON input and output values accepted by one command. */
export type CommandContract = {
  input: JsonValue;
  output: JsonValue;
};
export type CommandMap = Record<string, CommandContract>;
export type EventMap = Record<string, JsonValue>;

/** Default timeouts and limits for requests, subscriptions, and retained IDs. */
export const API_LIMITS = {
  handshakeTimeoutMs: 10000,
  shutdownTimeoutMs: 2000,
  maxCommandDurationMs: 30000,
  // Includes SDK listen cleanup and WebView IDs awaiting replies after cancellation or timeout.
  maxPending: 128,
  maxSubscriptions: 128,
  // Recent IDs in acceptance order; pending IDs remain protected separately.
  // This history does not cap total requests.
  maxRequestIds: 1024,
} as const;

declare const hostContext: unique symbol;
/** Compile-time brand for host-issued IDs; it is not a security token. */
export type HostContext = string & {
  readonly [hostContext]: true;
};

/** Protocol error represented by validated wire code and optional details. */
export class BunawayError extends Error {
  readonly code: WireError["code"];
  readonly details?: WireError["details"];

  constructor(error: WireError) {
    const safe = validate(errorSchema, error);
    super(safe.message);
    this.name = "BunawayError";
    this.code = safe.code;
    if (safe.details !== undefined) {
      this.details = safe.details;
    }
  }
}
