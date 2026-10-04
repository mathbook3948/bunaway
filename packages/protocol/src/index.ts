import {
  bootstrapSchema,
  type errorSchema,
  hostResponseSchema,
  messageSchema,
  policySchema,
  processSchema,
} from "./schema.ts";
import { type Infer, parse, ProtocolError, serialize, validate } from "./validation.ts";

export {
  bootstrapSchema,
  errorSchema,
  hostResponseSchema,
  messageSchema,
  policySchema,
  processSchema,
} from "./schema.ts";
export { type JsonValue, MAX_JSON_DEPTH, MAX_MESSAGE_BYTES, ProtocolError } from "./validation.ts";
export { type Infer, type Schema, validate as validateValue } from "./validation.ts";
export { API_LIMITS } from "./contracts.ts";
export {
  BunawayError,
  type AsyncDispose,
  type CancellationSignal,
  type CancellationController,
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
  CAPABILITIES_COMMAND,
  type Capabilities,
  type FrameworkCommands,
  type HostAPI,
  type HostCall,
  type HostInput,
  type HostOperation,
  type HostOutput,
  hostCallSchema,
  hostOperations,
  parseHostCall,
  serializeHostCall,
  validateHostOutput,
} from "./host-api.ts";

export type Message = Infer<typeof messageSchema>;
export type Hello = Extract<Message, { kind: "hello" }>;
export type WireError = Infer<typeof errorSchema>;
export type Policy = Infer<typeof policySchema>;
export type Bootstrap = Infer<typeof bootstrapSchema>;
export type HostResponse = Infer<typeof hostResponseSchema>;
export type ProcessFrame = Infer<typeof processSchema>;
export const PROCESS_IPC_VERSION = { major: 1, minor: 0 } as const;
export const parseProcessFrame = (text: string): ProcessFrame =>
  checkProcessPolicy(parse(processSchema, text));
export const serializeProcessFrame = (frame: ProcessFrame): string =>
  serialize(processSchema, checkProcessPolicy(validate(processSchema, frame)));

export const PROTOCOL_VERSION = { major: 1, minor: 0 } as const;

export const parseMessage = (text: string): Message => parse(messageSchema, text);
export const serializeMessage = (message: Message): string => serialize(messageSchema, message);
export function parseBootstrap(text: string): Bootstrap {
  const bootstrap = parse(bootstrapSchema, text);
  assertUniquePolicyViews(bootstrap.policy);
  return bootstrap;
}
export const parseHostResponse = (text: string): HostResponse => parse(hostResponseSchema, text);
export const serializeHostResponse = (response: HostResponse): string =>
  serialize(hostResponseSchema, response);

function assertUniquePolicyViews(policy: Policy | undefined): void {
  if (policy && new Set(policy.views.map((view) => view.id)).size !== policy.views.length) {
    throw new ProtocolError("INVALID_ARGUMENT", "Duplicate policy view.");
  }
}

function checkProcessPolicy(frame: ProcessFrame): ProcessFrame {
  if (frame.kind === "boot") assertUniquePolicyViews(frame.payload.policy);
  return frame;
}

export function parsePolicy(text: string): Policy {
  const policy = parse(policySchema, text);
  assertUniquePolicyViews(policy);
  return policy;
}

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
    throw new ProtocolError("UNSUPPORTED", "Incompatible protocol major version.");
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
