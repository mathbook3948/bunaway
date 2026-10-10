import {
  bootstrapSchema,
  type errorSchema,
  hostResponseSchema,
  messageSchema,
  policySchema,
  processSchema,
} from "./schema.ts";
import {
  type Infer,
  ProtocolError,
  parse,
  serialize,
  validate,
  validateSerialized,
} from "./validation.ts";

export {
  API_LIMITS,
  type AsyncDispose,
  BunawayError,
  type CancellationController,
  type CancellationSignal,
  type ClientMessage,
  type CommandContract,
  type CommandMap,
  type Dispose,
  type EventMap,
  type HostContext,
  type NegotiatedProtocol,
  type RuntimeIdentity,
  type ServerMessage,
  type Transport,
  type TransportEvent,
} from "./contracts.ts";
export {
  type HostAPI,
  type HostCall,
  type HostOperationContract,
  hostCallSchema,
  type NativePluginContract,
  type PermissionContract,
  parseHostCall,
  serializeHostCall,
} from "./host-api.ts";
export {
  type NativeRegistration,
  NativeRegistry,
  type NativeRegistryOptions,
  type PermissionMatcher,
} from "./native-registry.ts";
export {
  bootstrapSchema,
  errorSchema,
  hostResponseSchema,
  messageSchema,
  policySchema,
  processSchema,
} from "./schema.ts";
export {
  type Infer,
  type JsonValue,
  MAX_JSON_DEPTH,
  MAX_MESSAGE_BYTES,
  ProtocolError,
  type Schema,
  validate as validateValue,
} from "./validation.ts";

/** Messages exchanged between a client and its host over the WebView protocol. */
export type Message = Infer<typeof messageSchema>;
export type Hello = Extract<
  Message,
  {
    kind: "hello";
  }
>;
/** Wire error shape carried in protocol responses. */
export type WireError = Infer<typeof errorSchema>;
/** Permission grants and per-view command/event policy for an application. */
export type Policy = Infer<typeof policySchema>;
/** Initial configuration sent to a native runtime process. */
export type Bootstrap = Infer<typeof bootstrapSchema>;
/** Result or error body returned for a host operation request. */
export type HostResponse = Infer<typeof hostResponseSchema>;
/** Frames exchanged between the native host and its runtime process. */
export type ProcessFrame = Infer<typeof processSchema>;

/** Version of the host/runtime process envelope. */
export const PROCESS_IPC_VERSION = {
  major: 1,
  minor: 0,
} as const;
/** Parses a host/runtime frame and rejects duplicate view IDs in boot policy. */
export const parseProcessFrame = (text: string): ProcessFrame =>
  checkProcessPolicy(parse(processSchema, text));
/** Validates and serializes a host/runtime frame, including boot view ID uniqueness. */
export const serializeProcessFrame = (frame: ProcessFrame): string =>
  serialize(processSchema, frame, checkProcessPolicy);

/** Version advertised by clients and hosts during handshake. */
export const PROTOCOL_VERSION = {
  major: 1,
  minor: 0,
} as const;

/** Negotiated feature for the SDK's acknowledgement after accepting the server hello. */
export const SDK_READY_FEATURE = "sdk-ready";

/** Parses and validates one client/host protocol message. */
export const parseMessage = (text: string): Message =>
  parse(messageSchema, text);
/** Validates and serializes one client/host protocol message. */
export const serializeMessage = (message: Message): string =>
  serialize(messageSchema, message);
/** Returns a detached message checked against its schema and exact serialized size, without encoding it. */
export const validateMessage = (message: Message): Message =>
  validateSerialized(messageSchema, message);

/** Parses native runtime bootstrap JSON and rejects duplicate view IDs in policy. */
export function parseBootstrap(text: string): Bootstrap {
  const bootstrap = parse(bootstrapSchema, text);
  assertUniquePolicyViews(bootstrap.policy);
  return bootstrap;
}
/** Parses and validates a host operation response body. */
export const parseHostResponse = (text: string): HostResponse =>
  parse(hostResponseSchema, text);
/** Validates and serializes a host operation response body. */
export const serializeHostResponse = (response: HostResponse): string =>
  serialize(hostResponseSchema, response);

/** Rejects duplicate view IDs, a cross-field rule JSON Schema cannot express. */
function assertUniquePolicyViews(policy: Policy | undefined): void {
  if (
    policy &&
    new Set(policy.views.map((view) => view.id)).size !== policy.views.length
  ) {
    throw new ProtocolError("INVALID_ARGUMENT", "Duplicate policy view.");
  }
}

/** Applies policy checks that depend on the kind of process frame. */
function checkProcessPolicy(frame: ProcessFrame): ProcessFrame {
  if (frame.kind === "boot") {
    assertUniquePolicyViews(frame.payload.policy);
  }
  return frame;
}

/** Parses application policy JSON and rejects duplicate view IDs. */
export function parsePolicy(text: string): Policy {
  const policy = parse(policySchema, text);
  assertUniquePolicyViews(policy);
  return policy;
}

/**
 * Negotiates the shared major version, highest shared minor, and common features.
 * @throws {ProtocolError} If either input is invalid or the major versions differ.
 */
export function negotiateProtocol(
  local: Hello,
  remote: Hello,
): Pick<Hello, "protocol" | "features"> {
  const localHello = validate(messageSchema, local);
  const remoteHello = validate(messageSchema, remote);
  if (localHello.kind !== "hello" || remoteHello.kind !== "hello") {
    throw new ProtocolError("INVALID_ARGUMENT", "Expected protocol handshake.");
  }
  if (localHello.protocol.major !== remoteHello.protocol.major) {
    throw new ProtocolError(
      "UNSUPPORTED",
      "Incompatible protocol major version.",
    );
  }
  return {
    protocol: {
      major: localHello.protocol.major,
      minor: Math.min(localHello.protocol.minor, remoteHello.protocol.minor),
    },
    features: localHello.features
      .filter((feature) => remoteHello.features.includes(feature))
      .sort(),
  };
}
