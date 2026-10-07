import type { Infer, JsonValue, Schema } from "./validation.ts";
import { ProtocolError, parse, serialize, validate } from "./validation.ts";

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

const windowTarget = {
  type: "object",
  properties: {
    view: {
      type: "string",
      pattern: "^[A-Za-z0-9_.:-]{1,128}$(?![\\s\\S])",
    },
  },
  required: [
    "view",
  ],
  additionalProperties: false,
} as const;
const windowResult = {
  input: windowTarget,
  output: {
    const: null,
  },
} as const;

// These controls belong to the framework because it owns the window lifecycle.
export const hostOperations = {
  "windows.list": {
    input: {
      const: null,
    },
    output: {
      type: "array",
      maxItems: 128,
      items: {
        type: "object",
        properties: {
          view: windowTarget.properties.view,
          open: {
            type: "boolean",
          },
        },
        required: [
          "view",
          "open",
        ],
        additionalProperties: false,
      },
    },
  },
  "windows.create": windowResult,
  "windows.recreate": windowResult,
  "windows.show": windowResult,
  "windows.hide": windowResult,
  "windows.focus": windowResult,
  "windows.close": {
    input: windowTarget,
    output: {
      type: "boolean",
    },
  },
  "windows.setSize": {
    input: {
      ...windowTarget,
      properties: {
        ...windowTarget.properties,
        width: {
          type: "integer",
          minimum: 200,
          maximum: 4096,
        },
        height: {
          type: "integer",
          minimum: 200,
          maximum: 4096,
        },
      },
      required: [
        "view",
        "width",
        "height",
      ],
    },
    output: {
      const: null,
    },
  },
  "windows.setPosition": {
    input: {
      ...windowTarget,
      properties: {
        ...windowTarget.properties,
        x: {
          type: "integer",
          minimum: -32768,
          maximum: 32767,
        },
        y: {
          type: "integer",
          minimum: -32768,
          maximum: 32767,
        },
      },
      required: [
        "view",
        "x",
        "y",
      ],
    },
    output: {
      const: null,
    },
  },
  "windows.setFullscreen": {
    input: {
      ...windowTarget,
      properties: {
        ...windowTarget.properties,
        fullscreen: {
          type: "boolean",
        },
      },
      required: [
        "view",
        "fullscreen",
      ],
    },
    output: {
      const: null,
    },
  },
  "windows.setCloseConfirmation": {
    input: {
      ...windowTarget,
      properties: {
        ...windowTarget.properties,
        message: {
          anyOf: [
            {
              const: null,
            },
            {
              type: "string",
              maxLength: 1024,
              pattern: "^[^\\u0000]+$(?![\\s\\S])",
            },
          ],
        },
      },
      required: [
        "view",
        "message",
      ],
    },
    output: {
      const: null,
    },
  },
} as const satisfies Record<
  string,
  {
    input: Schema;
    output: Schema;
  }
>;

export type HostOperation = keyof typeof hostOperations;
export type HostInput<K extends HostOperation> = Infer<
  (typeof hostOperations)[K]["input"]
>;
export type HostOutput<K extends HostOperation> = Infer<
  (typeof hostOperations)[K]["output"]
>;
export type WindowCall = {
  [K in HostOperation]: {
    operation: K;
    payload: HostInput<K>;
  };
}[HostOperation];
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

export function isWindowOperation(name: string): name is HostOperation {
  return Object.hasOwn(hostOperations, name);
}

export function validateWindowCall(call: HostCall): WindowCall {
  const envelope = validate(hostCallSchema, call) as HostCall;
  if (!isWindowOperation(envelope.operation)) {
    throw new ProtocolError(
      "INVALID_ARGUMENT",
      "Expected a framework window operation.",
    );
  }
  return {
    operation: envelope.operation,
    payload: validate(
      hostOperations[envelope.operation].input,
      envelope.payload,
    ),
  } as WindowCall;
}

export function parseWindowCall(text: string): WindowCall {
  return validateWindowCall(parseHostCall(text));
}

export function validateHostOutput<K extends HostOperation>(
  operation: K,
  value: unknown,
): HostOutput<K> {
  return validate(hostOperations[operation].output, value) as HostOutput<K>;
}

// Bound to the originating command/backend lifetime; callers cannot choose a context.
export interface HostAPI {
  call<K extends HostOperation>(
    operation: K,
    input: HostInput<K>,
  ): Promise<HostOutput<K>>;
  call<I extends Schema, O extends Schema>(
    contract: HostOperationContract<I, O>,
    input: Infer<I>,
  ): Promise<Infer<O>>;
}
