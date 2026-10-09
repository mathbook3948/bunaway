import type { Infer, JsonValue, Schema } from "./validation.ts";
import { parse, serialize } from "./validation.ts";

/**
 * Declares a host operation's input/output schemas and the permission required
 * before the host executes it.
 */
export type HostOperationContract<
  I extends Schema = Schema,
  O extends Schema = Schema,
> = {
  readonly name: string;
  readonly input: I;
  readonly output: O;
  readonly permission: string;
  /** Omit when the platform's OS permission requirements are not known. */
  readonly osPermission?: "not-required";
};
/** Declares a plugin permission and, when needed, the schema for its scope values. */
export type PermissionContract = {
  readonly name: string;
  readonly scope?: Schema;
};
/** Collects the host operations and permissions owned by one native plugin. */
export type NativePluginContract = {
  readonly operations: readonly HostOperationContract[];
  readonly permissions: readonly PermissionContract[];
};

/** A host operation name and its JSON input payload. */
export type HostCall = {
  operation: string;
  payload: JsonValue;
};

/** JSON Schema for host calls carried over the host-owned process channel. */
export const hostCallSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    operation: {
      type: "string",
      pattern: "^[A-Za-z0-9_.:-]+$(?![\\s\\S])",
      maxLength: 128,
    },
    payload: {},
  },
  required: [
    "operation",
    "payload",
  ],
  additionalProperties: false,
} as const;

/** Parses and validates a serialized host call. Invalid text throws ProtocolError. */
export const parseHostCall = (text: string): HostCall =>
  parse(hostCallSchema, text);
/** Validates and serializes a host call. Invalid data throws ProtocolError. */
export const serializeHostCall = (call: HostCall): string =>
  serialize(hostCallSchema, call);

/**
 * Host operations bound to the originating command or backend lifetime.
 * Implementations resolve permission and execution context; callers cannot choose it.
 */
export interface HostAPI {
  /**
   * Calls a registered operation; rejection uses BunawayError for invalid input,
   * cancellation, permission denial, and host failures.
   */
  call<I extends Schema, O extends Schema>(
    contract: HostOperationContract<I, O>,
    input: Infer<I>,
  ): Promise<Infer<O>>;
}
