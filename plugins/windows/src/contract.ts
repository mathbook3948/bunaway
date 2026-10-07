import {
  type HostCall,
  hostCallSchema,
  type Infer,
  ProtocolError,
  parseHostCall,
  type Schema,
  validateValue as validate,
} from "@bunaway/protocol";

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

// Selected window-control contracts.
export const windowOperations = {
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

export type WindowOperation = keyof typeof windowOperations;
export type WindowInput<K extends WindowOperation> = Infer<
  (typeof windowOperations)[K]["input"]
>;
export type WindowOutput<K extends WindowOperation> = Infer<
  (typeof windowOperations)[K]["output"]
>;
export type WindowCall = {
  [K in WindowOperation]: {
    operation: K;
    payload: WindowInput<K>;
  };
}[WindowOperation];
export function isWindowOperation(name: string): name is WindowOperation {
  return Object.hasOwn(windowOperations, name);
}

export function validateWindowCall(call: HostCall): WindowCall {
  const envelope = validate(hostCallSchema, call) as HostCall;
  if (!isWindowOperation(envelope.operation)) {
    throw new ProtocolError(
      "INVALID_ARGUMENT",
      "Expected a window plugin operation.",
    );
  }
  return {
    operation: envelope.operation,
    payload: validate(
      windowOperations[envelope.operation].input,
      envelope.payload,
    ),
  } as WindowCall;
}

export function parseWindowCall(text: string): WindowCall {
  return validateWindowCall(parseHostCall(text));
}

export function validateWindowOutput<K extends WindowOperation>(
  operation: K,
  value: unknown,
): WindowOutput<K> {
  return validate(windowOperations[operation].output, value) as WindowOutput<K>;
}
