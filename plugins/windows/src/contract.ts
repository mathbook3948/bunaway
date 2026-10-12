import {
  MAX_WINDOW_DIMENSION,
  MIN_WINDOW_DIMENSION,
} from "@bunaway/plugin-api/native";
import {
  errorSchema,
  type HostCall,
  hostCallSchema,
  type Infer,
  ProtocolError,
  parseHostCall,
  type TypedSchema,
  toJSONSchema,
  validateValue as validate,
  type WireError,
} from "@bunaway/protocol";
import { z } from "zod";

export const WINDOW_VIEW_NAME_PATTERN = "^[A-Za-z0-9_.:-]{1,128}$(?![\\s\\S])";

// Win32 geometry uses signed 32-bit components; WM_DPICHANGED carries a 16-bit DPI.
export const MIN_WINDOW_COORDINATE = -2147483648;

export const MAX_WINDOW_COORDINATE = 2147483647;

const MAX_WINDOW_DPI = 65535;
const WINDOW_TEXT_PATTERN = "^[^\\u0000]+$(?![\\s\\S])";

// The protocol owns this wire shape. Its open details field is bounded JSON
// before validation, so the converted schema retains WireError's value type.
const wireErrorDefinition = z.fromJSONSchema(
  JSON.parse(JSON.stringify(errorSchema)),
) as z.ZodType<WireError, WireError>;
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

const coordinate = z
  .int()
  .min(MIN_WINDOW_COORDINATE)
  .max(MAX_WINDOW_COORDINATE);

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

/** State and bounds shared by native events and snapshot recovery. Bounds are physical outer pixels. */
const snapshotDefinition = z.strictObject({
  windowId: windowTarget.shape.view,
  viewId: windowTarget.shape.view,
  revision: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  state: z.strictObject({
    visible: z.boolean(),
    focused: z.boolean(),
    minimized: z.boolean(),
    maximized: z.boolean(),
    fullscreen: z.boolean(),
  }),
  bounds: boundsOutput,
});
export const windowSnapshotSchema = toJSONSchema(snapshotDefinition);

/** A single ordered subscription observes every committed window transition. */
const preparationPhase = z.enum([
  "pending",
  "ready",
  "failed",
  "cancelled",
]);

/** Recoverable preparation snapshot; revisions belong to the existing windowId lifetime. */
const readinessDefinition = z.strictObject({
  windowId: windowTarget.shape.view,
  viewId: windowTarget.shape.view,
  documentGeneration: snapshotDefinition.shape.revision,
  revision: snapshotDefinition.shape.revision,
  nativeCreated: z.boolean(),
  document: preparationPhase,
  sdk: preparationPhase,
  error: z.union([
    z.null(),
    wireErrorDefinition,
  ]),
});
export const windowReadinessSchema = toJSONSchema(readinessDefinition);

const changedDefinition = snapshotDefinition.extend({
  changes: z
    .array(
      z.enum([
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
      ]),
    )
    .min(1)
    .max(12),
});
const changedSchema = toJSONSchema(changedDefinition);
/** Ordered native transitions and preparation snapshots, subject to view event policy. */
export const windowEvents: {
  "windows.readiness": TypedSchema<z.output<typeof readinessDefinition>>;
  "windows.changed": TypedSchema<z.output<typeof changedDefinition>>;
} = {
  "windows.readiness": windowReadinessSchema,
  "windows.changed": {
    ...changedSchema,
    // Uniqueness belongs to the shared event contract, beyond the Zod array shape.
    properties: {
      ...changedSchema.properties,
      changes: {
        ...changedSchema.properties?.changes,
        uniqueItems: true,
      },
    },
  },
};

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
const operationDefinitions = {
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
      .max(128),
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
    output: z.array(windowIdentitySchema).max(128),
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
type SerializedOperations = {
  [K in keyof typeof operationDefinitions]: {
    input: TypedSchema<z.output<(typeof operationDefinitions)[K]["input"]>>;
    output: TypedSchema<z.output<(typeof operationDefinitions)[K]["output"]>>;
  };
};
// The mapping preserves operation names and converts each source schema pair once.
export const windowOperations = Object.fromEntries(
  Object.entries(operationDefinitions).map(([name, operation]) => [
    name,
    {
      input: toJSONSchema(operation.input),
      output: toJSONSchema(operation.output),
    },
  ]),
) as SerializedOperations;

export type WindowOperation = keyof typeof windowOperations;

export type WindowInput<K extends WindowOperation> = z.input<
  (typeof operationDefinitions)[K]["input"]
>;

export type WindowOutput<K extends WindowOperation> = z.output<
  (typeof operationDefinitions)[K]["output"]
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

/** Caller keys preserve each operation's source Zod input and output schema. */
type WindowDefinitions = {
  [K in keyof typeof operationDefinitions as K extends `windows.${infer Name}`
    ? Name
    : never]: (typeof operationDefinitions)[K];
};
// Every operation key has the windows prefix; its removal preserves the schema pair.
export const windowDefinitions = Object.fromEntries(
  Object.entries(operationDefinitions).map(([name, operation]) => [
    name.slice("windows.".length),
    operation,
  ]),
) as WindowDefinitions;
