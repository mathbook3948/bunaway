import {
  isDownloadSnapshotWithinLimits,
  MAX_WEBVIEW_DOWNLOADS,
  MAX_WINDOW_COORDINATE,
  MAX_WINDOW_DIMENSION,
  MAX_WINDOW_INSTANCES,
  MAX_WINDOWS,
  MIN_WINDOW_COORDINATE,
  MIN_WINDOW_DIMENSION,
  type WindowAttentionMode,
} from "@bunaway/plugin-api/native";
import {
  errorSchema,
  type HostCall,
  hostCallSchema,
  type Infer,
  type JsonValue,
  ProtocolError,
  parseHostCall,
  validateValue as validate,
  validateValue,
  type WireError,
} from "@bunaway/protocol";
import { z } from "zod";

const coordinate = z
  .int()
  .min(MIN_WINDOW_COORDINATE)
  .max(MAX_WINDOW_COORDINATE);
export const monitorPointSchema = z.strictObject({
  x: coordinate,
  y: coordinate,
});
export const monitorRectSchema = z
  .strictObject({
    ...monitorPointSchema.shape,
    width: z.int().positive().max(MAX_WINDOW_COORDINATE),
    height: z.int().positive().max(MAX_WINDOW_COORDINATE),
  })
  .refine(
    (rect) =>
      rect.x + rect.width <= MAX_WINDOW_COORDINATE &&
      rect.y + rect.height <= MAX_WINDOW_COORDINATE,
  );
/** Physical virtual-screen bounds and work area, effective DPI and optional driver metrics. */
export const monitorSchema = z.strictObject({
  id: z.string().min(1).max(32),
  name: z.string().min(1).max(128),
  primary: z.boolean(),
  bounds: monitorRectSchema,
  workArea: monitorRectSchema,
  dpi: z.int().positive().max(65535),
  scaleFactor: z
    .number()
    .positive()
    .max(65535 / 96),
  rotation: z.union([
    z.literal(0),
    z.literal(90),
    z.literal(180),
    z.literal(270),
    z.null(),
  ]),
  refreshRate: z.union([
    z.int().min(2),
    z.null(),
  ]),
});
export type Monitor = z.output<typeof monitorSchema>;

// TypeScript declaration emission narrows the inferred empty details schema to {}.
// Spell out its JSON value type so the public contract retains null and primitives.
const monitorErrorSchema: z.ZodType<
  Omit<WireError, "details"> & {
    details?: JsonValue;
  }
> = z.unknown().transform((value, context) => {
  try {
    return validateValue(errorSchema, value);
  } catch {
    // Protocol validation throws; Zod safe parsing must report an issue instead.
    context.addIssue({
      code: "custom",
      message: "Invalid monitor error.",
    });
    return z.NEVER;
  }
});

/** Fresh observation used to recover after subscribing, navigation or a failed native query. */
export const monitorSnapshotSchema = z.strictObject({
  sourceId: z.uuid(),
  revision: z.int().nonnegative(),
  monitors: z.array(monitorSchema),
  error: z.union([
    z.null(),
    monitorErrorSchema,
  ]),
});
export type MonitorSnapshot = z.output<typeof monitorSnapshotSchema>;

/** Native event transport uses the protocol JSON-schema subset; metrics stay in the Zod snapshot. */
export const monitorChangeSchema = {
  type: "object",
  properties: {
    sourceId: {
      type: "string",
      maxLength: 36,
      pattern:
        "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$(?![\\s\\S])",
    },
    revision: {
      type: "integer",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    added: {
      type: "array",
      uniqueItems: true,
      items: {
        type: "string",
        maxLength: 32,
        pattern: "^[\\s\\S]+$",
      },
    },
    removed: {
      type: "array",
      uniqueItems: true,
      items: {
        type: "string",
        maxLength: 32,
        pattern: "^[\\s\\S]+$",
      },
    },
    changed: {
      type: "array",
      uniqueItems: true,
      items: {
        type: "string",
        maxLength: 32,
        pattern: "^[\\s\\S]+$",
      },
    },
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
    "sourceId",
    "revision",
    "added",
    "removed",
    "changed",
    "error",
  ],
  additionalProperties: false,
} as const;

export const WINDOW_VIEW_NAME_PATTERN = "^[A-Za-z0-9_.:-]{1,128}$(?![\\s\\S])";

// Win32 geometry uses signed 32-bit components; WM_DPICHANGED carries a 16-bit DPI.
export {
  MAX_WINDOW_COORDINATE,
  MIN_WINDOW_COORDINATE,
} from "@bunaway/plugin-api/native";

const MAX_WINDOW_DPI = 65535;
const WINDOW_TEXT_PATTERN = "^[^\\u0000]+$(?![\\s\\S])";
// Native captions and declarations bound UTF-16 code units; Zod max counts Unicode code points.
const nativeTitle = z
  .string()
  .max(1024)
  .refine(
    (title) => title.length <= 1024,
    "Window titles cannot exceed 1024 UTF-16 code units.",
  );
const windowTitle = nativeTitle.regex(new RegExp(WINDOW_TEXT_PATTERN, "u"));
// An empty accessible title removes the annotation and restores the caption as the screen reader name.
const accessibleTitle = windowTitle.or(z.literal(""));

const viewTarget = z.strictObject({
  view: z.string().regex(new RegExp(WINDOW_VIEW_NAME_PATTERN, "u")),
});

const windowTarget = z.strictObject({
  view: viewTarget.shape.view,
  windowId: viewTarget.shape.view.exactOptional(),
});

/** Must stay aligned with the plugin API's `WindowAttentionMode`. */
const attentionMode = z.enum([
  "untilFocused",
  "continuous",
]) satisfies z.ZodType<WindowAttentionMode>;

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

const creationDimension = z
  .int()
  .min(MIN_WINDOW_DIMENSION)
  .max(MAX_WINDOW_DIMENSION);

const creationResult = {
  input: z.strictObject({
    view: viewTarget.shape.view,
    options: z
      .strictObject({
        title: windowTitle.exactOptional(),
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
            focusable: z.boolean().exactOptional(),
            titlebar: z
              .enum([
                "system",
                "custom",
              ])
              .exactOptional(),
            alwaysOnTop: z.boolean().exactOptional(),
            skipTaskbar: z.boolean().exactOptional(),
            contentProtection: z.boolean().exactOptional(),
            maximized: z.boolean().exactOptional(),
            fullscreen: z.boolean().exactOptional(),
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
        alwaysOnTop: {
          type: "boolean",
        },
      },
      required: [
        "visible",
        "focused",
        "minimized",
        "maximized",
        "fullscreen",
        "alwaysOnTop",
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
/**
 * One lifetime transition of a single windowId, delivered to every open view whose policy allows
 * `windows.lifecycle` and `windows.listInstances`.
 *
 * - `created`: the native window and its WebView controller exist.
 * - `ready`: the window's first document reached readiness `ready`; later navigations do not repeat it.
 *   Not emitted when preparation fails or is cancelled.
 * - `closed`: the close was committed and its sessions were revoked, including children closed with a
 *   parent, forced closes and the previous windowId of a recreation.
 * - `destroyed`: the native window and WebView resources were released, always after `closed`.
 *
 * Each phase is emitted at most once per windowId in that order. A window whose creation failed before
 * `created` emits nothing. Nothing is emitted once app shutdown or session end has begun, because sessions
 * are being torn down. The closed window's own sessions are revoked first, so it never receives its own
 * `closed` or `destroyed`. The Windows and macOS hosts emit this event.
 */
export const windowLifecycleSchema = {
  type: "object",
  properties: {
    windowId: eventIdentity,
    viewId: eventIdentity,
    phase: {
      enum: [
        "created",
        "ready",
        "closed",
        "destroyed",
      ],
    },
  },
  required: [
    "windowId",
    "viewId",
    "phase",
  ],
  additionalProperties: false,
} as const;
/**
 * A user close of this window is waiting for the app's decision. Delivered only to the closing window's
 * own current document, and only while that document listens for it and may call `windows.respondClose`;
 * otherwise the close proceeds as before (close confirmation, then closing). Answer with
 * `windows.respondClose({ requestId, allow })`. `requestId` is a positive integer, unique within the
 * windowId and increasing, so a late answer to an earlier request is rejected.
 *
 * Covers the title bar, Alt+F4 and system menu, WebView `window.close()` and the public `windows.close`.
 * It is not sent for recreation, splashscreen handoff, trusted `windows.destroy`, closing children with a
 * parent, app quit, shutdown or session end, nor when `closeBehavior` hides the window. While a request is
 * pending, further user closes of that window are ignored while `windows.close` and `windows.recreate`
 * fail with BUSY and the wait continues. There is no deadline; a navigation or revoked session of the
 * document, the document ending its last `windows.closeRequested` subscription (for example after a
 * listener failure), a forced close, trusted `windows.destroy`, app quit and session end also end the
 * wait. A request that ends without an answer leaves the window open. The Windows and macOS hosts emit
 * this event; on macOS the user closes are the title bar button, `performClose:` and the public `windows.close`, since a
 * WebView `window.close()` does not close the window there.
 */
export const windowCloseRequestedSchema = {
  type: "object",
  properties: {
    windowId: eventIdentity,
    viewId: eventIdentity,
    requestId: {
      type: "integer",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    },
  },
  required: [
    "windowId",
    "viewId",
    "requestId",
  ],
  additionalProperties: false,
} as const;
/** Ordered native transitions and preparation snapshots, subject to view event policy. */
export const windowEvents = {
  "windows.closeRequested": windowCloseRequestedSchema,
  "windows.monitorsChanged": monitorChangeSchema,
  "windows.readiness": windowReadinessSchema,
  "windows.lifecycle": windowLifecycleSchema,
  "windows.changed": {
    ...windowSnapshotSchema,
    properties: {
      ...windowSnapshotSchema.properties,
      changes: {
        type: "array",
        minItems: 1,
        maxItems: 16,
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
            "enterAlwaysOnTop",
            "leaveAlwaysOnTop",
            "move",
            "resize",
            "moved",
            "resized",
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
  "windows.getMonitorSnapshot": {
    input: z.null(),
    output: monitorSnapshotSchema,
  },
  "windows.getMonitors": {
    input: z.null(),
    output: z.array(monitorSchema),
  },
  "windows.getPrimaryMonitor": {
    input: z.null(),
    output: monitorSchema,
  },
  "windows.getMonitor": {
    input: windowTarget,
    output: monitorSchema,
  },
  "windows.getMonitorNearestPoint": {
    input: monitorPointSchema,
    output: monitorSchema,
  },
  "windows.getMonitorNearestRect": {
    input: monitorRectSchema,
    output: monitorSchema,
  },
  "windows.getCursorPosition": {
    input: z.null(),
    output: monitorPointSchema,
  },
  "windows.showPrintUI": {
    input: windowTarget.extend({
      kind: z
        .enum([
          "browser",
          "system",
        ])
        .exactOptional(),
    }),
    output: z.null(),
  },
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
      .max(MAX_WEBVIEW_DOWNLOADS)
      .refine(isDownloadSnapshotWithinLimits),
  },
  "windows.approveDownload": downloadResult,
  "windows.cancelDownload": downloadResult,
  "windows.pauseDownload": downloadResult,
  "windows.resumeDownload": downloadResult,
  "windows.forgetDownload": downloadResult,
  "windows.getWebViewState": {
    input: windowTarget,
    output: z.strictObject({
      url: z.string(),
      title: z.string(),
      loading: z.boolean(),
      canGoBack: z.boolean(),
      canGoForward: z.boolean(),
      zoomFactor: z.number().positive(),
      focused: z.boolean(),
    }),
  },
  "windows.navigateWebView": {
    input: windowTarget.extend({
      url: z
        .string()
        .min(1)
        .max(8192)
        .regex(new RegExp(WINDOW_TEXT_PATTERN, "u")),
    }),
    output: z.null(),
  },
  "windows.reloadWebView": windowResult,
  "windows.stopWebView": windowResult,
  "windows.goBack": windowStateResult,
  "windows.goForward": windowStateResult,
  "windows.setZoomFactor": {
    input: windowTarget.extend({
      factor: z.number().min(0.25).max(5),
    }),
    output: z.number().positive(),
  },
  "windows.openDevTools": windowResult,
  "windows.getWebViewAudioState": {
    input: windowTarget,
    output: z.strictObject({
      muted: z.boolean(),
      playing: z.boolean(),
    }),
  },
  "windows.setWebViewAudioMuted": {
    input: windowTarget.extend({
      muted: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.setTaskbarProgress": {
    input: z.union([
      windowTarget.extend({
        state: z.enum([
          "none",
          "indeterminate",
        ]),
      }),
      windowTarget.extend({
        state: z.enum([
          "normal",
          "paused",
          "error",
        ]),
        value: z.number().min(0).max(1),
      }),
    ]),
    output: z.null(),
  },
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
  /**
   * Answers the pending `windows.closeRequested` request of the target window. `allow: true` lets the
   * close continue without the target's own close confirmation; `false` keeps the window open.
   * Fails with INVALID_ARGUMENT when `requestId` is not pending (answered, cancelled or never sent).
   * Only the trusted backend or the document of the asked window may answer; any other caller fails
   * with PERMISSION_DENIED, even with a valid `requestId`.
   */
  "windows.respondClose": {
    input: z.strictObject({
      view: viewTarget.shape.view,
      windowId: viewTarget.shape.view.exactOptional(),
      requestId: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
      allow: z.boolean(),
    }),
    output: z.null(),
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
  "windows.setFocusable": {
    input: windowTarget.extend({
      focusable: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.isFocusable": windowStateResult,
  "windows.getTitlebar": {
    input: windowTarget,
    output: z.enum([
      "system",
      "custom",
    ]),
  },
  "windows.setAlwaysOnTop": {
    input: windowTarget.extend({
      alwaysOnTop: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.isAlwaysOnTop": windowStateResult,
  "windows.setSkipTaskbar": {
    input: windowTarget.extend({
      skipTaskbar: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.isSkipTaskbar": windowStateResult,
  "windows.setContentProtection": {
    input: windowTarget.extend({
      contentProtection: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.isContentProtected": windowStateResult,
  "windows.requestAttention": {
    input: windowTarget.extend({
      mode: attentionMode.exactOptional(),
    }),
    output: z.null(),
  },
  "windows.cancelAttention": windowResult,
  "windows.setMinimizable": {
    input: windowTarget.extend({
      minimizable: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.isMinimizable": windowStateResult,
  "windows.setMaximizable": {
    input: windowTarget.extend({
      maximizable: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.isMaximizable": windowStateResult,
  "windows.setClosable": {
    input: windowTarget.extend({
      closable: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.isClosable": windowStateResult,
  "windows.setTitle": {
    input: windowTarget.extend({
      title: windowTitle,
    }),
    output: z.null(),
  },
  "windows.getTitle": {
    input: windowTarget,
    output: nativeTitle,
  },
  "windows.setAccessibleTitle": {
    input: windowTarget.extend({
      title: accessibleTitle,
    }),
    output: z.null(),
  },
  "windows.getAccessibleTitle": {
    input: windowTarget,
    output: windowTitle.nullable(),
  },
  "windows.setResizable": {
    input: windowTarget.extend({
      resizable: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.isResizable": windowStateResult,
  "windows.setMovable": {
    input: windowTarget.extend({
      movable: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.isMovable": windowStateResult,
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
  "windows.center": {
    input: windowTarget.extend({
      monitorId: monitorSchema.shape.id.exactOptional(),
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
