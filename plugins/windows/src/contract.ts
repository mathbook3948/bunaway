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
// Win32 geometry uses signed 32-bit components; WM_DPICHANGED carries a 16-bit DPI.
export const MIN_WINDOW_COORDINATE = -2147483648;
export const MAX_WINDOW_COORDINATE = 2147483647;
const MAX_WINDOW_DPI = 65535;

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
const windowStateResult = {
  input: windowTarget,
  output: {
    type: "boolean",
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

const coordinate = {
  type: "integer",
  minimum: MIN_WINDOW_COORDINATE,
  maximum: MAX_WINDOW_COORDINATE,
} as const;
const dimension = {
  type: "integer",
  minimum: 0,
  maximum: MAX_WINDOW_COORDINATE,
} as const;
const dpi = {
  type: "integer",
  minimum: 1,
  maximum: MAX_WINDOW_DPI,
} as const;
const positionProperties = {
  x: coordinate,
  y: coordinate,
} as const;
const sizeProperties = {
  width: dimension,
  height: dimension,
} as const;
const boundsProperties = {
  ...positionProperties,
  ...sizeProperties,
} as const;
const geometryTarget = {
  ...windowTarget,
  properties: {
    ...windowTarget.properties,
    unit: {
      anyOf: [
        {
          const: "physical",
        },
        {
          const: "logical",
        },
      ],
    },
  },
} as const;
const positionOutput = {
  type: "object",
  properties: {
    ...positionProperties,
    dpi,
  },
  required: [
    "x",
    "y",
    "dpi",
  ],
  additionalProperties: false,
} as const;
const geometryPositionInput = {
  ...geometryTarget,
  properties: {
    ...geometryTarget.properties,
    ...positionProperties,
  },
  required: [
    "view",
    "x",
    "y",
  ],
} as const;
const geometrySizeInput = {
  ...geometryTarget,
  properties: {
    ...geometryTarget.properties,
    ...sizeProperties,
  },
  required: [
    "view",
    "width",
    "height",
  ],
} as const;
const geometryBoundsInput = {
  ...geometryTarget,
  properties: {
    ...geometryTarget.properties,
    ...boundsProperties,
  },
  required: [
    "view",
    "x",
    "y",
    "width",
    "height",
  ],
} as const;
const sizeOutput = {
  type: "object",
  properties: {
    ...sizeProperties,
    dpi,
  },
  required: [
    "width",
    "height",
    "dpi",
  ],
  additionalProperties: false,
} as const;
const boundsOutput = {
  type: "object",
  properties: {
    ...boundsProperties,
    dpi,
  },
  required: [
    "x",
    "y",
    "width",
    "height",
    "dpi",
  ],
  additionalProperties: false,
} as const;

/** State and bounds shared by native events and snapshot recovery. Bounds are physical outer pixels. */
export const windowSnapshotSchema = {
  type: "object",
  properties: {
    windowId: windowTarget.properties.view,
    viewId: windowTarget.properties.view,
    revision: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    state: {
      type: "object",
      properties: {
        visible: {
          type: "boolean",
        },
        focused: {
          type: "boolean",
        },
        minimized: {
          type: "boolean",
        },
        maximized: {
          type: "boolean",
        },
        fullscreen: {
          type: "boolean",
        },
      },
      required: [
        "visible",
        "focused",
        "minimized",
        "maximized",
        "fullscreen",
      ],
      additionalProperties: false,
    },
    bounds: boundsOutput,
  },
  required: [
    "windowId",
    "viewId",
    "revision",
    "state",
    "bounds",
  ],
  additionalProperties: false,
} as const;
/** A single ordered subscription observes every committed window transition. */
export const windowEvents = {
  "windows.changed": {
    ...windowSnapshotSchema,
    properties: {
      ...windowSnapshotSchema.properties,
      changes: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        uniqueItems: true,
        items: {
          type: "string",
          enum: [
            "shown",
            "hidden",
            "focus",
            "blur",
            "unmaximize",
            "minimize",
            "maximize",
            "restore",
            "enterFullscreen",
            "leaveFullscreen",
            "move",
            "resize",
          ],
        },
      },
    },
    required: [
      ...windowSnapshotSchema.required,
      "changes",
    ],
  },
} as const;
/** Native event payloads for typed client subscriptions. */
export type WindowEvents = {
  [K in keyof typeof windowEvents]: Infer<(typeof windowEvents)[K]>;
};

const geometryValue = {
  anyOf: [
    {
      type: "object",
      properties: positionProperties,
      required: [
        "x",
        "y",
      ],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: sizeProperties,
      required: [
        "width",
        "height",
      ],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: boundsProperties,
      required: [
        "x",
        "y",
        "width",
        "height",
      ],
      additionalProperties: false,
    },
  ],
} as const;
const conversionOutput = {
  type: "object",
  properties: {
    value: geometryValue,
    dpi,
  },
  required: [
    "value",
    "dpi",
  ],
  additionalProperties: false,
} as const;

/** Schemas for window operations, used to validate calls and their results. */
export const windowOperations = {
  "windows.getSnapshot": {
    input: windowTarget,
    output: windowSnapshotSchema,
  },
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
  "windows.minimize": windowResult,
  "windows.maximize": windowResult,
  "windows.unmaximize": windowResult,
  "windows.restore": windowResult,
  "windows.toggleMaximize": windowResult,
  "windows.isMinimized": windowStateResult,
  "windows.isMaximized": windowStateResult,
  "windows.isFullscreen": windowStateResult,
  "windows.isVisible": windowStateResult,
  "windows.isFocused": windowStateResult,
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
  "windows.getContentSize": {
    input: geometryTarget,
    output: sizeOutput,
  },
  "windows.setContentPosition": {
    input: geometryPositionInput,
    output: windowResult.output,
  },
  "windows.setOuterSize": {
    input: geometrySizeInput,
    output: windowResult.output,
  },
  "windows.setContentBounds": {
    input: geometryBoundsInput,
    output: windowResult.output,
  },
  "windows.setOuterBounds": {
    input: geometryBoundsInput,
    output: windowResult.output,
  },
  "windows.getOuterSize": {
    input: geometryTarget,
    output: sizeOutput,
  },
  "windows.getContentPosition": {
    input: geometryTarget,
    output: positionOutput,
  },
  "windows.getOuterPosition": {
    input: geometryTarget,
    output: positionOutput,
  },
  "windows.getContentBounds": {
    input: geometryTarget,
    output: boundsOutput,
  },
  "windows.getOuterBounds": {
    input: geometryTarget,
    output: boundsOutput,
  },
  "windows.getNormalBounds": {
    input: geometryTarget,
    output: boundsOutput,
  },
  "windows.toLogical": {
    input: {
      ...windowTarget,
      properties: {
        ...windowTarget.properties,
        value: geometryValue,
      },
      required: [
        "view",
        "value",
      ],
    },
    output: conversionOutput,
  },
  "windows.toPhysical": {
    input: {
      ...windowTarget,
      properties: {
        ...windowTarget.properties,
        value: geometryValue,
      },
      required: [
        "view",
        "value",
      ],
    },
    output: conversionOutput,
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

/** Discriminated union binding each operation name to its matching input shape. */
export type WindowCall = {
  [K in WindowOperation]: {
    operation: K;
    payload: WindowInput<K>;
  };
}[WindowOperation];

/** Check whether a host operation name belongs to this plugin. */
export function isWindowOperation(name: string): name is WindowOperation {
  return Object.hasOwn(windowOperations, name);
}

/** Validate the host-call envelope and the selected operation's input. */
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

/** Parse and validate a serialized window host call. */
export function parseWindowCall(text: string): WindowCall {
  return validateWindowCall(parseHostCall(text));
}

/** Validate an adapter result against the selected operation's output schema. */
export function validateWindowOutput<K extends WindowOperation>(
  operation: K,
  value: unknown,
): WindowOutput<K> {
  return validate(windowOperations[operation].output, value) as WindowOutput<K>;
}
