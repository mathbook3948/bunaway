import {
  bootstrapSchema,
  type errorSchema,
  hostResponseSchema,
  messageSchema,
  policySchema,
} from "./schema.ts";
import { type Infer, parse, ProtocolError, serialize, validate } from "./validation.ts";

export {
  bootstrapSchema,
  errorSchema,
  hostResponseSchema,
  messageSchema,
  policySchema,
} from "./schema.ts";
export { type JsonValue, MAX_JSON_DEPTH, MAX_MESSAGE_BYTES, ProtocolError } from "./validation.ts";

export type Message = Infer<typeof messageSchema>;
export type Hello = Extract<Message, { kind: "hello" }>;
export type WireError = Infer<typeof errorSchema>;
export type Policy = Infer<typeof policySchema>;
export type Bootstrap = Infer<typeof bootstrapSchema>;
export type HostResponse = Infer<typeof hostResponseSchema>;

export const PROTOCOL_VERSION = { major: 1, minor: 0 } as const;

export const parseMessage = (text: string): Message => parse(messageSchema, text);
export const serializeMessage = (message: Message): string => serialize(messageSchema, message);
export const parseBootstrap = (text: string): Bootstrap => parse(bootstrapSchema, text);
export const parseHostResponse = (text: string): HostResponse => parse(hostResponseSchema, text);
export const serializeHostResponse = (response: HostResponse): string =>
  serialize(hostResponseSchema, response);

export function parsePolicy(text: string): Policy {
  const policy = parse(policySchema, text);
  if (new Set(policy.views.map((view) => view.id)).size !== policy.views.length) {
    throw new ProtocolError("INVALID_ARGUMENT", "Duplicate policy view.");
  }
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
