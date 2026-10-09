import {
  MAX_WINDOW_DIMENSION,
  MIN_WINDOW_DIMENSION,
} from "@bunaway/plugin-api/native";
import {
  type HostCall,
  hostCallSchema,
  type Infer,
  ProtocolError,
  parseHostCall,
  type Schema,
  validateValue as validate,
} from "@bunaway/protocol";

export const WINDOW_VIEW_NAME_PATTERN = "^[A-Za-z0-9_.:-]{1,128}$(?![\\s\\S])";

const windowTarget = {
  type: "object",
  properties: {
    view: {
      type: "string",
      pattern: WINDOW_VIEW_NAME_PATTERN,
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
const sizeDimension = {
  anyOf: [
    {
      const: null,
    },
    {
      type: "integer",
      minimum: MIN_WINDOW_DIMENSION,
      maximum: MAX_WINDOW_DIMENSION,
    },
  ],
} as const;
const sizePairOutput = {
  type: "object",
  properties: {
    width: sizeDimension,
    height: sizeDimension,
  },
  required: [
    "width",
    "height",
  ],
  additionalProperties: false,
} as const;
const sizeConstraintsOutput = {
  type: "object",
  properties: {
    minWidth: sizeDimension,
    minHeight: sizeDimension,
    maxWidth: sizeDimension,
    maxHeight: sizeDimension,
  },
  required: [
    "minWidth",
    "minHeight",
    "maxWidth",
    "maxHeight",
  ],
  additionalProperties: false,
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
          minimum: MIN_WINDOW_DIMENSION,
          maximum: MAX_WINDOW_DIMENSION,
        },
        height: {
          type: "integer",
          minimum: MIN_WINDOW_DIMENSION,
          maximum: MAX_WINDOW_DIMENSION,
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
  "windows.getMinSize": {
    input: windowTarget,
    output: sizePairOutput,
  },
  "windows.getMaxSize": {
    input: windowTarget,
    output: sizePairOutput,
  },
  "windows.setMinSize": {
    input: {
      ...windowTarget,
      properties: {
        ...windowTarget.properties,
        width: sizeDimension,
        height: sizeDimension,
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
  "windows.setMaxSize": {
    input: {
      ...windowTarget,
      properties: {
        ...windowTarget.properties,
        width: sizeDimension,
        height: sizeDimension,
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
  "windows.getSizeConstraints": {
    input: windowTarget,
    output: sizeConstraintsOutput,
  },
  "windows.setSizeConstraints": {
    input: {
      ...windowTarget,
      properties: {
        ...windowTarget.properties,
        minWidth: sizeDimension,
        minHeight: sizeDimension,
        maxWidth: sizeDimension,
        maxHeight: sizeDimension,
      },
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
