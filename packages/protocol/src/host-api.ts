import type { Infer, JsonValue, Schema } from "./validation.ts";
import { parse, serialize } from "./validation.ts";

export type HostOperationContract<
  I extends Schema = Schema,
  O extends Schema = Schema,
> = {
  readonly name: string;
  readonly input: I;
  readonly output: O;
  readonly permission: string;
  readonly osPermission?: "not-required";
};
export type PermissionContract = {
  readonly name: string;
  readonly scope?: Schema;
};
export type NativePluginContract = {
  readonly operations: readonly HostOperationContract[];
  readonly permissions: readonly PermissionContract[];
};

export type HostCall = {
  operation: string;
  payload: JsonValue;
};

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

export const parseHostCall = (text: string): HostCall =>
  parse(hostCallSchema, text);
export const serializeHostCall = (call: HostCall): string =>
  serialize(hostCallSchema, call);

// Bound to the originating command/backend lifetime; callers cannot choose a context.
export interface HostAPI {
  call<I extends Schema, O extends Schema>(
    contract: HostOperationContract<I, O>,
    input: Infer<I>,
  ): Promise<Infer<O>>;
}
