import {
  isDownloadSnapshotWithinLimits,
  MAX_TRAY_ICO_BYTES,
  MAX_WEBVIEW_DOWNLOADS,
  MAX_WINDOW_ASPECT_RATIO,
  MAX_WINDOW_COORDINATE,
  MAX_WINDOW_DIMENSION,
  MIN_WINDOW_ASPECT_RATIO,
  MIN_WINDOW_COORDINATE,
  MIN_WINDOW_DIMENSION,
  NATIVE_THUMBNAIL_BUTTON_LIMIT,
  parseNativeIco,
  WINDOW_BACKGROUND_COLOR_PATTERN,
  type WindowAttentionMode,
  type WindowResizeDirection,
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

/** Placements for `windows.moveToAnchor` within a monitor work area. */
export const WINDOW_ANCHORS = [
  "top-left",
  "top",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
] as const;
export type WindowAnchor = (typeof WINDOW_ANCHORS)[number];
/** Largest logical gap `windows.moveToAnchor` accepts to the work-area edge and `windows.moveNextToRect` accepts to the reference rectangle. */
const MAX_ANCHOR_MARGIN = 8192;
/** Sides of a reference rectangle where `windows.moveNextToRect` can put a window. */
export const WINDOW_RECT_PLACEMENTS = [
  "above",
  "below",
  "left",
  "right",
] as const;
export type WindowRectPlacement = (typeof WINDOW_RECT_PLACEMENTS)[number];
/** Alignment along the axis parallel to the chosen side of the reference rectangle. */
export const WINDOW_RECT_ALIGNMENTS = [
  "start",
  "center",
  "end",
] as const;
export type WindowRectAlignment = (typeof WINDOW_RECT_ALIGNMENTS)[number];

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
/** Reference rectangle in physical screen coordinates; unlike a monitor, it may be empty, as `tray.getBounds` can report. */
const referenceRectSchema = z
  .strictObject({
    ...monitorPointSchema.shape,
    width: z.int().min(0).max(MAX_WINDOW_COORDINATE),
    height: z.int().min(0).max(MAX_WINDOW_COORDINATE),
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

// Base64 ICO, the same input as the tray `setIcon`. The shared ICO validation rejects a malformed
// directory or frame as INVALID_ARGUMENT before any native resource exists.
const icoBytes = z
  .string()
  .min(4)
  .max(Math.ceil(MAX_TRAY_ICO_BYTES / 3) * 4)
  .refine((value) => parseNativeIco(value) !== undefined, "Invalid ICO.");

/** App-chosen name of a thumbnail toolbar button; reported back unchanged when the button is pressed. */
const THUMBNAIL_BUTTON_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";
/** `THUMBBUTTON.szTip` holds 260 UTF-16 code units including the terminator. */
const MAX_THUMBNAIL_BUTTON_TOOLTIP = 259;

const thumbnailButtonFlags = [
  "enabled",
  "disabled",
  "dismissonclick",
  "nobackground",
  "hidden",
  "noninteractive",
] as const;

const thumbnailButton = z.strictObject({
  id: z.string().regex(new RegExp(THUMBNAIL_BUTTON_ID_PATTERN, "u")),
  ico: icoBytes,
  tooltip: z
    .string()
    .max(MAX_THUMBNAIL_BUTTON_TOOLTIP)
    .refine((value) => !value.includes("\0"), "The tooltip cannot contain NUL.")
    .default(""),
  flags: z
    .array(z.enum(thumbnailButtonFlags))
    .max(thumbnailButtonFlags.length)
    .refine((flags) => new Set(flags).size === flags.length, "Duplicate flag.")
    .refine(
      (flags) => !(flags.includes("enabled") && flags.includes("disabled")),
      "A button cannot be both enabled and disabled.",
    )
    .default([]),
});

/** Must stay aligned with the plugin API's `WindowAttentionMode`. */
const attentionMode = z.enum([
  "untilFocused",
  "continuous",
]) satisfies z.ZodType<WindowAttentionMode>;

/** Must stay aligned with the plugin API's `WindowResizeDirection`. */
const resizeDirection = z.enum([
  "north",
  "south",
  "east",
  "west",
  "northEast",
  "northWest",
  "southEast",
  "southWest",
]) satisfies z.ZodType<WindowResizeDirection>;

const windowIdentifier = z
  .string()
  .regex(new RegExp(WINDOW_VIEW_NAME_PATTERN, "u"));

const windowResult = {
  input: z.null(),
  output: z.null(),
};

/** Content width / height; null means no lock. */
const aspectRatio = z
  .number()
  .min(MIN_WINDOW_ASPECT_RATIO)
  .max(MAX_WINDOW_ASPECT_RATIO)
  .nullable();

const windowStateResult = {
  input: z.null(),
  output: z.boolean(),
};

const downloadTarget = z.strictObject({
  id: z.string().uuid(),
});

const downloadResult = {
  input: downloadTarget,
  output: z.null(),
};

const sizeDimension = z.union([
  z.null(),
  z.int().min(MIN_WINDOW_DIMENSION).max(MAX_WINDOW_DIMENSION),
]);

/** Opaque `#RGB` or `#RRGGBB`; returned values are always lowercase `#rrggbb`. */
const windowBackgroundColor = z.string().regex(WINDOW_BACKGROUND_COLOR_PATTERN);
/** System backdrop materials, in Electron's `setBackgroundMaterial` spelling. */
const windowBackgroundMaterial = z.enum([
  "auto",
  "none",
  "mica",
  "acrylic",
  "tabbed",
]);

const creationDimension = z
  .int()
  .min(MIN_WINDOW_DIMENSION)
  .max(MAX_WINDOW_DIMENSION);

const creationResult = {
  input: z.strictObject({
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
            backgroundColor: windowBackgroundColor.exactOptional(),
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
 * One lifetime transition of a single windowId, delivered to the open document when its policy allows
 * `windows.lifecycle` and `windows.getSnapshot`.
 *
 * - `created`: the native window and its WebView controller exist.
 * - `ready`: the window's first document reached readiness `ready`; later navigations do not repeat it.
 *   Not emitted when preparation fails or is cancelled.
 * - `closed`: the close was committed and its sessions were revoked, including forced closes and the
 *   previous windowId of a recreation.
 * - `destroyed`: the native window and WebView resources were released, always after `closed`.
 *
 * Each phase is emitted at most once per windowId in that order. A window whose creation failed before
 * `created` emits nothing. Nothing is emitted once app shutdown or session end has begun, because sessions
 * are being torn down. The closed window's own sessions are revoked first, so it never receives its own
 * `closed` or `destroyed`. The Windows and macOS hosts emit this event.
 *
 * The backend's `windows.waitForLifecycle` sees the same phases, with one consequence of the rule above:
 * when the only window closes and the close ends the app (`closeBehavior` `quit`), shutdown has begun, so
 * that window's own `closed` and `destroyed` never reach the backend. They are published when the app keeps
 * running, for a recreation or under `keep-alive`.
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
 * It is not sent for recreation, trusted `windows.destroy`, app quit, shutdown or session end, nor when `closeBehavior` hides the window. While a request is
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
/** App commands published by `windows.appCommand`; codes outside this set are not delivered. */
export const windowAppCommands = [
  "browser-backward",
  "browser-forward",
  "browser-refresh",
  "browser-stop",
  "browser-search",
  "browser-favorites",
  "browser-home",
  "volume-mute",
  "volume-down",
  "volume-up",
  "media-nexttrack",
  "media-previoustrack",
  "media-stop",
  "media-play-pause",
  "launch-mail",
  "launch-media-select",
  "launch-app1",
  "launch-app2",
  "bass-down",
  "bass-boost",
  "bass-up",
  "treble-down",
  "treble-up",
  "microphone-volume-mute",
  "microphone-volume-down",
  "microphone-volume-up",
  "help",
  "find",
  "new",
  "open",
  "close",
  "save",
  "print",
  "undo",
  "redo",
  "copy",
  "cut",
  "paste",
  "reply-to-mail",
  "forward-mail",
  "send-mail",
  "spell-check",
  "mic-on-off-toggle",
  "correction-list",
  "media-play",
  "media-pause",
  "media-record",
  "media-fast-forward",
  "media-rewind",
  "media-channel-up",
  "media-channel-down",
  "delete",
] as const;
/** A navigation, media or editing command the window received from the system (Windows only). */
export const windowAppCommandSchema = {
  type: "object",
  properties: {
    windowId: eventIdentity,
    viewId: eventIdentity,
    command: {
      enum: [
        ...windowAppCommands,
      ],
    },
  },
  required: [
    "windowId",
    "viewId",
    "command",
  ],
  additionalProperties: false,
} as const;
/** A thumbnail toolbar button the user pressed; `buttonId` is an id the app set with `windows.setThumbnailToolbar` (Windows only). */
export const windowThumbnailToolbarClickedSchema = {
  type: "object",
  properties: {
    windowId: eventIdentity,
    viewId: eventIdentity,
    buttonId: {
      type: "string",
      pattern: THUMBNAIL_BUTTON_ID_PATTERN,
    },
  },
  required: [
    "windowId",
    "viewId",
    "buttonId",
  ],
  additionalProperties: false,
} as const;
/** A right click on the title bar or system menu icon, in physical screen pixels (Windows only). */
export const windowSystemContextMenuSchema = {
  type: "object",
  properties: {
    windowId: eventIdentity,
    viewId: eventIdentity,
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
  },
  required: [
    "windowId",
    "viewId",
    "x",
    "y",
  ],
  additionalProperties: false,
} as const;
/**
 * The document title of the window's page changed (Windows only). `title` is the page's
 * `document.title`, cut to at most 1024 UTF-16 code units without splitting a surrogate pair.
 * The native caption is not changed by this event.
 */
export const windowDocumentTitleChangedSchema = {
  type: "object",
  properties: {
    windowId: eventIdentity,
    viewId: eventIdentity,
    title: {
      type: "string",
      maxLength: 1024,
    },
  },
  required: [
    "windowId",
    "viewId",
    "title",
  ],
  additionalProperties: false,
} as const;
/**
 * The favicon of the window's page changed (Windows only). `url` is the address of the icon the
 * page declared, or the empty string when WebView2 reports no address or the address is longer
 * than 2048 UTF-16 code units. The icon bytes are not delivered; the page fetches the address itself.
 */
export const windowDocumentFaviconChangedSchema = {
  type: "object",
  properties: {
    windowId: eventIdentity,
    viewId: eventIdentity,
    url: {
      type: "string",
      maxLength: 2048,
    },
  },
  required: [
    "windowId",
    "viewId",
    "url",
  ],
  additionalProperties: false,
} as const;
/** Ordered native transitions and preparation snapshots, subject to view event policy. */
export const windowEvents = {
  "windows.appCommand": windowAppCommandSchema,
  "windows.systemContextMenu": windowSystemContextMenuSchema,
  "windows.thumbnailToolbarClicked": windowThumbnailToolbarClickedSchema,
  "windows.closeRequested": windowCloseRequestedSchema,
  "windows.documentTitleChanged": windowDocumentTitleChangedSchema,
  "windows.documentFaviconChanged": windowDocumentFaviconChangedSchema,
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
    input: z.null(),
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
    input: z.strictObject({
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
    input: z.strictObject({
      enabled: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.getDownloads": {
    input: z.null(),
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
    input: z.null(),
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
    input: z.strictObject({
      url: z
        .string()
        .min(1)
        .max(8192)
        .regex(new RegExp(WINDOW_TEXT_PATTERN, "u")),
    }),
    output: z.null(),
  },
  "windows.reloadWebView": {
    input: z.strictObject({
      ignoreCache: z.boolean().exactOptional(),
    }),
    output: z.null(),
  },
  "windows.stopWebView": windowResult,
  "windows.goBack": windowStateResult,
  "windows.goForward": windowStateResult,
  "windows.setZoomFactor": {
    input: z.strictObject({
      factor: z.number().min(0.25).max(5),
    }),
    output: z.number().positive(),
  },
  "windows.openDevTools": windowResult,
  "windows.getWebViewAudioState": {
    input: z.null(),
    output: z.strictObject({
      muted: z.boolean(),
      playing: z.boolean(),
    }),
  },
  "windows.setWebViewAudioMuted": {
    input: z.strictObject({
      muted: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.setTaskbarProgress": {
    input: z.union([
      z.strictObject({
        state: z.enum([
          "none",
          "indeterminate",
        ]),
      }),
      z.strictObject({
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
  // Region is client-area DIPs (96 DPI), matching setSize; null clears the clip.
  "windows.setThumbnailClip": {
    input: z.strictObject({
      region: z
        .strictObject({
          x: z.int().min(0).max(MAX_WINDOW_COORDINATE),
          y: z.int().min(0).max(MAX_WINDOW_COORDINATE),
          width: z.int().positive().max(MAX_WINDOW_COORDINATE),
          height: z.int().positive().max(MAX_WINDOW_COORDINATE),
        })
        .refine(
          (rect) =>
            rect.x + rect.width <= MAX_WINDOW_COORDINATE &&
            rect.y + rect.height <= MAX_WINDOW_COORDINATE,
          "The thumbnail clip edges cannot exceed the Win32 coordinate range.",
        )
        .nullable(),
    }),
    output: z.null(),
  },
  // null or an empty string restores the default thumbnail tooltip (the window title).
  "windows.setThumbnailToolTip": {
    input: z.strictObject({
      toolTip: accessibleTitle.nullable(),
    }),
    output: z.null(),
  },
  // A null ico removes the overlay and ignores description; otherwise description is the accessibility text.
  "windows.setOverlayIcon": {
    input: z.strictObject({
      ico: icoBytes.nullable(),
      description: accessibleTitle,
    }),
    output: z.null(),
  },
  // Replaces the whole toolbar: buttons keep their order, ids are unique and an empty list hides every button.
  "windows.setThumbnailToolbar": {
    input: z.strictObject({
      buttons: z
        .array(thumbnailButton)
        .max(NATIVE_THUMBNAIL_BUTTON_LIMIT)
        .refine(
          (buttons) =>
            new Set(buttons.map((button) => button.id)).size === buttons.length,
          "Thumbnail button ids must be unique.",
        ),
    }),
    output: z.null(),
  },
  // A null ico returns the window to the application icon from the EXE resource.
  "windows.setIcon": {
    input: z.strictObject({
      ico: icoBytes.nullable(),
    }),
    output: z.null(),
  },
  "windows.hasCustomIcon": windowStateResult,
  "windows.getReadiness": {
    input: z.null(),
    output: readinessDefinition,
  },
  "windows.getSnapshot": {
    input: z.null(),
    output: snapshotDefinition,
  },
  "windows.isOpen": {
    input: z.null(),
    output: z.boolean(),
  },
  /**
   * Backend subscription to `windows.lifecycle`: resolves with the next phase of any window lifetime,
   * or with the first retained phase after `after` (a `sequence` from an earlier result). A loop that
   * passes each result's `sequence` back sees every phase while it keeps up with the retained history; a
   * jump in `sequence` means older phases were dropped. Backend only and without a permission
   * check, since it only reports that a window appeared or ended. Phases are not sent once shutdown starts.
   */
  "windows.waitForLifecycle": {
    input: z.strictObject({
      after: z.int().min(0).max(Number.MAX_SAFE_INTEGER).exactOptional(),
    }),
    output: z.strictObject({
      sequence: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
      windowId: windowIdentifier,
      viewId: windowIdentifier,
      phase: z.enum([
        "created",
        "ready",
        "closed",
        "destroyed",
      ]),
    }),
  },
  /**
   * Waits for the next WebView process failure the host handled (Windows only), or returns the first
   * retained one after `after` (a `sequence` from an earlier result), like `windows.waitForLifecycle`.
   * `kind` names the failed WebView2 process. `recovery` is `reload` when the host navigated the view
   * again and `close` when the browser process exited and the window was closed. Backend only and
   * without a permission check. Failures are not sent once shutdown starts.
   */
  "windows.waitForProcessFailure": {
    input: z.strictObject({
      after: z.int().min(0).max(Number.MAX_SAFE_INTEGER).exactOptional(),
    }),
    output: z.strictObject({
      sequence: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
      windowId: windowIdentifier,
      viewId: windowIdentifier,
      kind: z.enum([
        "browser-exited",
        "renderer-exited",
        "renderer-unresponsive",
        "frame-renderer-exited",
        "utility-exited",
        "sandbox-helper-exited",
        "gpu-exited",
        "plugin-exited",
        "plugin-broker-exited",
        "unknown-exited",
      ]),
      recovery: z.enum([
        "reload",
        "close",
      ]),
    }),
  },
  /**
   * Waits for the next change of a WebView's mute setting or playback state (Windows only), or
   * returns the first retained change after `after` (a `sequence` from an earlier result), like
   * `windows.waitForLifecycle`. The result is the state after the change: `muted` is the controller's
   * mute setting and `playing` whether the document is playing audio. Backend only and without a
   * permission check. Changes are not sent once shutdown starts.
   */
  "windows.waitForAudioChange": {
    input: z.strictObject({
      after: z.int().min(0).max(Number.MAX_SAFE_INTEGER).exactOptional(),
    }),
    output: z.strictObject({
      sequence: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
      windowId: windowIdentifier,
      viewId: windowIdentifier,
      muted: z.boolean(),
      playing: z.boolean(),
    }),
  },
  "windows.create": creationResult,
  "windows.recreate": creationResult,
  "windows.show": windowResult,
  "windows.showInactive": windowResult,
  "windows.hide": windowResult,
  "windows.focus": windowResult,
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
  "windows.isNormal": windowStateResult,
  "windows.close": {
    input: z.null(),
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
      requestId: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
      allow: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.destroy": windowStateResult,
  "windows.setEnabled": {
    input: z.strictObject({
      enabled: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.isEnabled": windowStateResult,
  "windows.setFocusable": {
    input: z.strictObject({
      focusable: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.isFocusable": windowStateResult,
  "windows.getTitlebar": {
    input: z.null(),
    output: z.enum([
      "system",
      "custom",
    ]),
  },
  "windows.setAlwaysOnTop": {
    input: z.strictObject({
      alwaysOnTop: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.isAlwaysOnTop": windowStateResult,
  "windows.moveTop": windowResult,
  "windows.moveToBottom": windowResult,
  "windows.setSkipTaskbar": {
    input: z.strictObject({
      skipTaskbar: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.isSkipTaskbar": windowStateResult,
  "windows.setContentProtection": {
    input: z.strictObject({
      contentProtection: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.isContentProtected": windowStateResult,
  "windows.requestAttention": {
    input: z.strictObject({
      mode: attentionMode.exactOptional(),
    }),
    output: z.null(),
  },
  "windows.cancelAttention": windowResult,
  "windows.setMinimizable": {
    input: z.strictObject({
      minimizable: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.isMinimizable": windowStateResult,
  "windows.setMaximizable": {
    input: z.strictObject({
      maximizable: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.isMaximizable": windowStateResult,
  "windows.setFullscreenable": {
    input: z.strictObject({
      fullscreenable: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.isFullscreenable": windowStateResult,
  "windows.setOpacity": {
    input: z.strictObject({
      opacity: z.number().min(0).max(1),
    }),
    output: z.null(),
  },
  "windows.getOpacity": {
    input: z.null(),
    output: z.number().min(0).max(1),
  },
  "windows.setHasShadow": {
    input: z.strictObject({
      hasShadow: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.hasShadow": windowStateResult,
  "windows.setRoundedCorners": {
    input: z.strictObject({
      roundedCorners: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.hasRoundedCorners": windowStateResult,
  "windows.setBackgroundMaterial": {
    input: z.strictObject({
      material: windowBackgroundMaterial,
    }),
    output: z.null(),
  },
  "windows.getBackgroundMaterial": {
    input: z.null(),
    output: windowBackgroundMaterial,
  },
  "windows.setBackgroundColor": {
    input: z.strictObject({
      color: windowBackgroundColor,
    }),
    output: z.null(),
  },
  "windows.getBackgroundColor": {
    input: z.null(),
    output: windowBackgroundColor.nullable(),
  },
  "windows.setIgnoreMouseEvents": {
    input: z.strictObject({
      ignore: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.isIgnoreMouseEvents": windowStateResult,
  "windows.setClosable": {
    input: z.strictObject({
      closable: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.isClosable": windowStateResult,
  "windows.setTitle": {
    input: z.strictObject({
      title: windowTitle,
    }),
    output: z.null(),
  },
  "windows.getTitle": {
    input: z.null(),
    output: nativeTitle,
  },
  "windows.setAccessibleTitle": {
    input: z.strictObject({
      title: accessibleTitle,
    }),
    output: z.null(),
  },
  "windows.getAccessibleTitle": {
    input: z.null(),
    output: windowTitle.nullable(),
  },
  "windows.setResizable": {
    input: z.strictObject({
      resizable: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.isResizable": windowStateResult,
  "windows.setMovable": {
    input: z.strictObject({
      movable: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.isMovable": windowStateResult,
  "windows.setAspectRatio": {
    input: z.strictObject({
      ratio: aspectRatio,
    }),
    output: z.null(),
  },
  "windows.getAspectRatio": {
    input: z.null(),
    output: aspectRatio,
  },
  "windows.startDragging": windowResult,
  "windows.startResizeDragging": {
    input: z.strictObject({
      direction: resizeDirection,
    }),
    output: z.null(),
  },
  "windows.setSize": {
    input: z.strictObject({
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
      value: geometryValue,
    }),
    output: conversionOutput,
  },
  "windows.toPhysical": {
    input: z.strictObject({
      value: geometryValue,
    }),
    output: conversionOutput,
  },
  "windows.getMinSize": {
    input: z.null(),
    output: sizePairOutput,
  },
  "windows.getMaxSize": {
    input: z.null(),
    output: sizePairOutput,
  },
  "windows.setMinSize": {
    input: z.strictObject({
      width: sizeDimension,
      height: sizeDimension,
    }),
    output: z.null(),
  },
  "windows.setMaxSize": {
    input: z.strictObject({
      width: sizeDimension,
      height: sizeDimension,
    }),
    output: z.null(),
  },
  "windows.getSizeConstraints": {
    input: z.null(),
    output: sizeConstraintsOutput,
  },
  "windows.setSizeConstraints": {
    input: z.strictObject({
      minWidth: sizeDimension.exactOptional(),
      minHeight: sizeDimension.exactOptional(),
      maxWidth: sizeDimension.exactOptional(),
      maxHeight: sizeDimension.exactOptional(),
    }),
    output: z.null(),
  },
  "windows.setPosition": {
    input: z.strictObject({
      x: z.int().min(-32768).max(32767),
      y: z.int().min(-32768).max(32767),
    }),
    output: z.null(),
  },
  "windows.center": {
    input: z.strictObject({
      monitorId: monitorSchema.shape.id.exactOptional(),
    }),
    output: z.null(),
  },
  "windows.moveToAnchor": {
    input: z.strictObject({
      anchor: z.enum(WINDOW_ANCHORS),
      monitorId: monitorSchema.shape.id.exactOptional(),
      margin: z.int().min(0).max(MAX_ANCHOR_MARGIN).exactOptional(),
    }),
    output: z.null(),
  },
  "windows.moveNextToRect": {
    input: z.strictObject({
      rect: referenceRectSchema,
      placement: z.enum(WINDOW_RECT_PLACEMENTS),
      align: z.enum(WINDOW_RECT_ALIGNMENTS).exactOptional(),
      margin: z.int().min(0).max(MAX_ANCHOR_MARGIN).exactOptional(),
    }),
    output: z.null(),
  },
  "windows.setFullscreen": {
    input: z.strictObject({
      fullscreen: z.boolean(),
    }),
    output: z.null(),
  },
  "windows.setCloseConfirmation": {
    input: z.strictObject({
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
