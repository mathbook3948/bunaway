import {
  MAX_WEBVIEW_DOWNLOADS,
  MAX_WINDOW_COORDINATE,
  MAX_WINDOW_DIMENSION,
  MAX_WINDOW_INSTANCES,
  MAX_WINDOWS,
  MIN_WINDOW_COORDINATE,
  MIN_WINDOW_DIMENSION,
} from "@bunaway/plugin-api/native";
import {
  errorSchema,
  type HostCall,
  hostCallSchema,
  type Infer,
  ProtocolError,
  parseHostCall,
  validateValue as validate,
} from "@bunaway/protocol";
import { z } from "zod";

export const WINDOW_VIEW_NAME_PATTERN = "^[A-Za-z0-9_.:-]{1,128}$(?![\\s\\S])";

// Win32 geometry uses signed 32-bit components; WM_DPICHANGED carries a 16-bit DPI.
export {
  MAX_WINDOW_COORDINATE,
  MIN_WINDOW_COORDINATE,
} from "@bunaway/plugin-api/native";

const MAX_WINDOW_DPI = 65535;
const WINDOW_TEXT_PATTERN = "^[^\\u0000]+$(?![\\s\\S])";

const viewTarget = z.strictObject({
  view: z.string().regex(new RegExp(WINDOW_VIEW_NAME_PATTERN, "u")),
});

const windowTarget = z.strictObject({
  view: viewTarget.shape.view,
  windowId: viewTarget.shape.view.exactOptional(),
});

const windowResult = {
  input: windowTarget,
  output: z.null(),
};

const windowStateResult = {
  input: windowTarget,
  output: z.boolean(),
};

const downloadTarget = windowTarget.extend({
  id: z.string().uuid(),
});

const downloadResult = {
  input: downloadTarget,
  output: z.null(),
};

const windowIdentitySchema = z.strictObject({
  windowId: windowTarget.shape.view,
  viewId: windowTarget.shape.view,
});

const windowLookupOutput = z.union([
  z.null(),
  windowIdentitySchema,
]);

const windowLookup = {
  input: z.null(),
  output: windowLookupOutput,
};

const sizeDimension = z.union([
  z.null(),
  z.int().min(MIN_WINDOW_DIMENSION).max(MAX_WINDOW_DIMENSION),
]);

const coordinate = z
  .int()
  .min(MIN_WINDOW_COORDINATE)
  .max(MAX_WINDOW_COORDINATE);

const creationDimension = z
  .int()
  .min(MIN_WINDOW_DIMENSION)
  .max(MAX_WINDOW_DIMENSION);

const creationResult = {
  input: z.strictObject({
    view: viewTarget.shape.view,
    options: z
      .strictObject({
        title: z
          .string()
          .max(1024)
          .regex(new RegExp(WINDOW_TEXT_PATTERN, "u"))
          .exactOptional(),
        window: z
          .strictObject({
            width: creationDimension.exactOptional(),
            height: creationDimension.exactOptional(),
            minWidth: sizeDimension.exactOptional(),
            minHeight: sizeDimension.exactOptional(),
            maxWidth: sizeDimension.exactOptional(),
            maxHeight: sizeDimension.exactOptional(),
            x: coordinate.nullable().exactOptional(),
            y: coordinate.nullable().exactOptional(),
            center: z.boolean().exactOptional(),
            useContentSize: z.boolean().exactOptional(),
            preventOverflow: z.boolean().exactOptional(),
          })
          .exactOptional(),
        visible: z.boolean().exactOptional(),
        showWhenReady: z
          .union([
            z.enum([
              "document",
              "sdk",
            ]),
            z.null(),
          ])
          .exactOptional(),
      })
      .exactOptional(),
  }),
  output: z.null(),
};

const sizePairOutput = z.strictObject({
  width: sizeDimension,
  height: sizeDimension,
});

const sizeConstraintsOutput = z.strictObject({
  minWidth: sizeDimension,
  minHeight: sizeDimension,
  maxWidth: sizeDimension,
  maxHeight: sizeDimension,
});

const dimension = z.int().min(0).max(MAX_WINDOW_COORDINATE);

const dpi = z.int().min(1).max(MAX_WINDOW_DPI);

const _positionProperties = {
  x: coordinate,
  y: coordinate,
};

const _sizeProperties = {
  width: dimension,
  height: dimension,
};

const _boundsProperties = {
  x: coordinate,
  y: coordinate,
  width: dimension,
  height: dimension,
};

const geometryTarget = z.strictObject({
  view: viewTarget.shape.view,
  windowId: viewTarget.shape.view.exactOptional(),
  unit: z
    .union([
      z.literal("physical"),
      z.literal("logical"),
    ])
    .exactOptional(),
});

const positionOutput = z.strictObject({
  x: coordinate,
  y: coordinate,
  dpi,
});

const geometryPositionInput = z.strictObject({
  view: viewTarget.shape.view,
  windowId: viewTarget.shape.view.exactOptional(),
  unit: z
    .union([
      z.literal("physical"),
      z.literal("logical"),
    ])
    .exactOptional(),
  x: coordinate,
  y: coordinate,
});

const geometrySizeInput = z.strictObject({
  view: viewTarget.shape.view,
  windowId: viewTarget.shape.view.exactOptional(),
  unit: z
    .union([
      z.literal("physical"),
      z.literal("logical"),
    ])
    .exactOptional(),
  width: dimension,
  height: dimension,
});

const geometryBoundsInput = z.strictObject({
  view: viewTarget.shape.view,
  windowId: viewTarget.shape.view.exactOptional(),
  unit: z
    .union([
      z.literal("physical"),
      z.literal("logical"),
    ])
    .exactOptional(),
  x: coordinate,
  y: coordinate,
  width: dimension,
  height: dimension,
});

const sizeOutput = z.strictObject({
  width: dimension,
  height: dimension,
  dpi,
});

const boundsOutput = z.strictObject({
  x: coordinate,
  y: coordinate,
  width: dimension,
  height: dimension,
  dpi,
});

// Native events retain their protocol JSON schemas; plugin operations below run Zod directly.
const eventIdentity = {
  type: "string",
  pattern: WINDOW_VIEW_NAME_PATTERN,
} as const;
/** State and bounds shared by native events and snapshot recovery. Bounds are physical outer pixels. */
export const windowSnapshotSchema = {
  type: "object",
  properties: {
    windowId: eventIdentity,
    viewId: eventIdentity,
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
    bounds: {
      type: "object",
      properties: {
        x: {
          type: "integer",
          minimum: MIN_WINDOW_COORDINATE,
          maximum: MAX_WINDOW_COORDINATE,
        },
        y: {
          type: "integer",
          minimum: MIN_WINDOW_COORDINATE,
          maximum: MAX_WINDOW_COORDINATE,
        },
        width: {
          type: "integer",
          minimum: 0,
          maximum: MAX_WINDOW_COORDINATE,
        },
        height: {
          type: "integer",
          minimum: 0,
          maximum: MAX_WINDOW_COORDINATE,
        },
        dpi: {
          type: "integer",
          minimum: 1,
          maximum: MAX_WINDOW_DPI,
        },
      },
      required: [
        "x",
        "y",
        "width",
        "height",
        "dpi",
      ],
      additionalProperties: false,
    },
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
const eventPreparationPhase = {
  enum: [
    "pending",
    "ready",
    "failed",
    "cancelled",
  ],
} as const;
/** Recoverable preparation snapshot; revisions belong to the existing windowId lifetime. */
export const windowReadinessSchema = {
  type: "object",
  properties: {
    windowId: eventIdentity,
    viewId: eventIdentity,
    documentGeneration: windowSnapshotSchema.properties.revision,
    revision: windowSnapshotSchema.properties.revision,
    nativeCreated: {
      type: "boolean",
    },
    document: eventPreparationPhase,
    sdk: eventPreparationPhase,
    error: {
      anyOf: [
        {
          const: null,
        },
        errorSchema,
      ],
    },
  },
  required: [
    "windowId",
    "viewId",
    "documentGeneration",
    "revision",
    "nativeCreated",
    "document",
    "sdk",
    "error",
  ],
  additionalProperties: false,
} as const;
/** Ordered native transitions and preparation snapshots, subject to view event policy. */
export const windowEvents = {
  "windows.readiness": windowReadinessSchema,
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
// Snapshot results also serve as protocol events. Reuse their contracts inside local Zod parsers.
const snapshotDefinition = z
  .unknown()
  .transform((value) => validate(windowSnapshotSchema, value));
const readinessDefinition = z
  .unknown()
  .transform((value) => validate(windowReadinessSchema, value));

/** Native event payloads for typed client subscriptions. */
export type WindowEvents = {
  [K in keyof typeof windowEvents]: Infer<(typeof windowEvents)[K]>;
};

const geometryValue = z.union([
  z.strictObject({
    x: coordinate,
    y: coordinate,
  }),
  z.strictObject({
    width: dimension,
    height: dimension,
  }),
  z.strictObject({
    x: coordinate,
    y: coordinate,
    width: dimension,
    height: dimension,
  }),
]);

const conversionOutput = z.strictObject({
  value: geometryValue,
  dpi,
});

/** Schemas for window operations, used to validate calls and their results. */
export const windowOperations = {
  "windows.setDownloadRequestsEnabled": {
    input: windowTarget.extend({
      enabled: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.getDownloads": {
    input: windowTarget,
    output: z
      .array(
        z.strictObject({
          id: z.string().uuid(),
          url: z.string(),
          mimeType: z.string(),
          contentDisposition: z.string(),
          path: z.string(),
          totalBytes: z.int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
          receivedBytes: z.int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
          state: z.enum([
            "pending",
            "inProgress",
            "interrupted",
            "completed",
            "cancelled",
          ]),
          interruptReason: z.int().min(0).nullable(),
          canResume: z.boolean(),
          paused: z.boolean(),
        }),
      )
      .max(MAX_WEBVIEW_DOWNLOADS),
  },
  "windows.approveDownload": downloadResult,
  "windows.cancelDownload": downloadResult,
  "windows.pauseDownload": downloadResult,
  "windows.resumeDownload": downloadResult,
  "windows.forgetDownload": downloadResult,
  "windows.createInstance": {
    input: creationResult.input,
    output: windowIdentitySchema,
  },
  "windows.recreateInstance": {
    input: creationResult.input.extend({
      windowId: viewTarget.shape.view,
    }),
    output: windowIdentitySchema,
  },
  "windows.listInstances": {
    input: z.null(),
    output: z.array(windowIdentitySchema),
  },
  "windows.getById": {
    input: z.strictObject({
      windowId: windowTarget.shape.view,
    }),
    output: windowLookupOutput,
  },
  "windows.getCurrent": windowLookup,
  "windows.getFocused": windowLookup,
  "windows.getLastActive": windowLookup,
  "windows.getReadiness": {
    input: windowTarget,
    output: readinessDefinition,
  },
  "windows.completeSplashscreen": {
    input: z.strictObject({
      view: viewTarget.shape.view,
      splash: windowTarget.shape.view,
    }),
    output: z.boolean(),
  },
  "windows.getSnapshot": {
    input: windowTarget,
    output: snapshotDefinition,
  },
  "windows.list": {
    input: z.null(),
    output: z
      .array(
        z.strictObject({
          view: windowTarget.shape.view,
          open: z.boolean(),
        }),
      )
      .max(MAX_WINDOWS),
  },
  "windows.create": creationResult,
  "windows.recreate": creationResult,
  "windows.show": windowResult,
  "windows.showInactive": windowResult,
  "windows.hide": windowResult,
  "windows.focus": windowResult,
  "windows.blur": windowStateResult,
  "windows.activate": windowStateResult,
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
  "windows.isDestroyed": windowStateResult,
  "windows.isNormal": windowStateResult,
  "windows.close": {
    input: windowTarget,
    output: z.boolean(),
  },
  "windows.destroy": windowStateResult,
  "windows.setParent": {
    input: z.strictObject({
      view: viewTarget.shape.view,
      windowId: viewTarget.shape.view.exactOptional(),
      parent: z.union([
        z.null(),
        windowTarget.shape.view,
      ]),
      modal: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.getParent": {
    input: windowTarget,
    output: windowLookupOutput,
  },
  "windows.getOwner": {
    input: windowTarget,
    output: windowLookupOutput,
  },
  "windows.getChildren": {
    input: windowTarget,
    output: z.array(windowIdentitySchema).max(MAX_WINDOW_INSTANCES),
  },
  "windows.setEnabled": {
    input: z.strictObject({
      view: viewTarget.shape.view,
      windowId: viewTarget.shape.view.exactOptional(),
      enabled: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.isEnabled": windowStateResult,
  "windows.setSize": {
    input: z.strictObject({
      view: viewTarget.shape.view,
      windowId: viewTarget.shape.view.exactOptional(),
      width: z.int().min(MIN_WINDOW_DIMENSION).max(MAX_WINDOW_DIMENSION),
      height: z.int().min(MIN_WINDOW_DIMENSION).max(MAX_WINDOW_DIMENSION),
    }),
    output: z.null(),
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
    input: z.strictObject({
      view: viewTarget.shape.view,
      windowId: viewTarget.shape.view.exactOptional(),
      value: geometryValue,
    }),
    output: conversionOutput,
  },
  "windows.toPhysical": {
    input: z.strictObject({
      view: viewTarget.shape.view,
      windowId: viewTarget.shape.view.exactOptional(),
      value: geometryValue,
    }),
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
    input: z.strictObject({
      view: viewTarget.shape.view,
      windowId: viewTarget.shape.view.exactOptional(),
      width: sizeDimension,
      height: sizeDimension,
    }),
    output: z.null(),
  },
  "windows.setMaxSize": {
    input: z.strictObject({
      view: viewTarget.shape.view,
      windowId: viewTarget.shape.view.exactOptional(),
      width: sizeDimension,
      height: sizeDimension,
    }),
    output: z.null(),
  },
  "windows.getSizeConstraints": {
    input: windowTarget,
    output: sizeConstraintsOutput,
  },
  "windows.setSizeConstraints": {
    input: z.strictObject({
      view: viewTarget.shape.view,
      windowId: viewTarget.shape.view.exactOptional(),
      minWidth: sizeDimension.exactOptional(),
      minHeight: sizeDimension.exactOptional(),
      maxWidth: sizeDimension.exactOptional(),
      maxHeight: sizeDimension.exactOptional(),
    }),
    output: z.null(),
  },
  "windows.setPosition": {
    input: z.strictObject({
      view: viewTarget.shape.view,
      windowId: viewTarget.shape.view.exactOptional(),
      x: z.int().min(-32768).max(32767),
      y: z.int().min(-32768).max(32767),
    }),
    output: z.null(),
  },
  "windows.setFullscreen": {
    input: z.strictObject({
      view: viewTarget.shape.view,
      windowId: viewTarget.shape.view.exactOptional(),
      fullscreen: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.setCloseConfirmation": {
    input: z.strictObject({
      view: viewTarget.shape.view,
      windowId: viewTarget.shape.view.exactOptional(),
      message: z.union([
        z.null(),
        z.string().max(1024).regex(new RegExp(WINDOW_TEXT_PATTERN, "u")),
      ]),
    }),
    output: z.null(),
  },
};

export type WindowOperation = keyof typeof windowOperations;

export type WindowInput<K extends WindowOperation> = z.input<
  (typeof windowOperations)[K]["input"]
>;

export type WindowOutput<K extends WindowOperation> = z.output<
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
  try {
    return {
      operation: envelope.operation,
      payload: windowOperations[envelope.operation].input.parse(
        envelope.payload,
      ),
    } as WindowCall;
  } catch {
    throw new ProtocolError("INVALID_ARGUMENT", "Invalid window plugin input.");
  }
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
  try {
    return windowOperations[operation].output.parse(
      validate({}, value),
    ) as WindowOutput<K>;
  } catch {
    throw new ProtocolError(
      "INVALID_ARGUMENT",
      "Invalid window plugin output.",
    );
  }
}

/** Caller keys preserve each operation's source Zod input and output schema. */
type WindowDefinitions = {
  [K in keyof typeof windowOperations as K extends `windows.${infer Name}`
    ? Name
    : never]: (typeof windowOperations)[K];
};
// Every operation key has the windows prefix; its removal preserves the schema pair.
export const windowDefinitions = Object.fromEntries(
  Object.entries(windowOperations).map(([name, operation]) => [
    name.slice("windows.".length),
    operation,
  ]),
) as WindowDefinitions;
