import { expect, test } from "bun:test";
import type {
  NativeWindow,
  NativeWindowServices,
} from "@bunaway/plugin-api/native";
import type { JsonValue } from "@bunaway/protocol";
import {
  type WindowOperation,
  windowOperations,
} from "#plugins/windows/src/contract";
import { createOperations } from "#plugins/windows/src/platforms/windows";

/** Pins how the Windows UI adapter maps each public window operation onto the native controls. */

type Call = [
  method: string,
  args: unknown[],
];
type Row = {
  operation: string;
  payload?: Record<string, unknown>;
  /** Native calls expected in order, including state queries made before the control. */
  calls: Call[];
  returns?: unknown;
  /** Native return values keyed by method, for rows whose final call is not the one that reads. */
  returnsBy?: Record<string, unknown>;
  result?: unknown;
  /** Message of the UNSUPPORTED error when the platform omits the control. */
  unsupported?: string | undefined;
};

const MESSAGES = {
  monitor: "Monitor queries are unavailable.",
  print: "WebView print dialogs are not implemented on this platform.",
  downloads: "WebView downloads are not implemented on this platform.",
  webview: "WebView control is not implemented on this platform.",
  audio: "WebView audio controls are not implemented on this platform.",
  close: "Close requests are not implemented on this platform.",
  relations: "Window ownership control is not implemented on this platform.",
  display: "Window display options are not implemented on this platform.",
  attention: "Window attention requests are not implemented on this platform.",
  focusability: "Window focusability is not implemented on this platform.",
  controls: "Native caption controls are not implemented on this platform.",
  fullscreenable: "Fullscreenable is not implemented on this platform.",
  opacity: "Window opacity is not implemented on this platform.",
  mouse: "Ignoring mouse events is not implemented on this platform.",
  shadow: "Window shadow control is not implemented on this platform.",
  roundedCorners: "Window corner control is not implemented on this platform.",
  backgroundMaterial:
    "Window background material is not implemented on this platform.",
  backgroundColor:
    "Window background color is not implemented on this platform.",
  accentColor: "Window accent color is not implemented on this platform.",
  title: "Window title control is not implemented on this platform.",
  movement: "Window movement controls are not implemented on this platform.",
  aspect: "Window aspect ratio locking is not implemented on this platform.",
  dragging:
    "Starting a window move or resize is not implemented on this platform.",
  center: "Window centering is not implemented on this platform.",
  progress: "Taskbar progress is not implemented on this platform.",
  clip: "Thumbnail clip is not implemented on this platform.",
  tooltip: "Thumbnail tooltip is not implemented on this platform.",
  overlay: "Taskbar overlay icon is not implemented on this platform.",
  toolbar: "Taskbar thumbnail toolbar is not implemented on this platform.",
  icon: "Window icon is not implemented on this platform.",
} as const;

const DOWNLOAD_ID = crypto.randomUUID();
const GEOMETRY = {
  x: 10,
  y: 20,
  width: 300,
  height: 400,
  dpi: 144,
};

/** A flag pair operation: `set` forwards the value, `get` returns the native value. */
function flag(
  setter: string,
  getter: string,
  field: string,
  unsupported: string,
): Row[] {
  return [
    {
      operation: `windows.${setter}`,
      payload: {
        [field]: true,
      },
      calls: [
        [
          setter,
          [
            true,
          ],
        ],
      ],
      result: null,
      unsupported,
    },
    {
      operation: `windows.${getter}`,
      calls: [
        [
          getter,
          [],
        ],
      ],
      returns: true,
      result: true,
      unsupported,
    },
  ];
}

const query = (
  name: string,
  returns: unknown,
  unsupported?: string | undefined,
  prefix: Call[] = [],
): Row => ({
  operation: `windows.${name}`,
  calls: [
    ...prefix,
    [
      name,
      [],
    ],
  ],
  returns,
  result: returns,
  unsupported,
});

const command = (
  name: string,
  unsupported?: string | undefined,
  method = name,
  prefix: Call[] = [],
): Row => ({
  operation: `windows.${name}`,
  calls: [
    ...prefix,
    [
      method,
      [],
    ],
  ],
  result: null,
  unsupported,
});

const fullscreenCheck: Call[] = [
  [
    "isFullscreen",
    [],
  ],
];

const rows: Row[] = [
  {
    operation: "windows.getMonitor",
    calls: [
      [
        "getMonitor",
        [],
      ],
    ],
    returns: {
      id: "monitor-1",
    },
    result: {
      id: "monitor-1",
    },
    unsupported: MESSAGES.monitor,
  },
  {
    operation: "windows.showPrintUI",
    calls: [
      [
        "showPrintUI",
        [
          "browser",
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.print,
  },
  {
    operation: "windows.showPrintUI",
    payload: {
      kind: "system",
    },
    calls: [
      [
        "showPrintUI",
        [
          "system",
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.print,
  },
  {
    operation: "windows.setDownloadRequestsEnabled",
    payload: {
      enabled: true,
    },
    calls: [
      [
        "downloads.setRequestsEnabled",
        [
          true,
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.downloads,
  },
  {
    operation: "windows.getDownloads",
    calls: [
      [
        "downloads.list",
        [],
      ],
    ],
    returns: [
      {
        id: DOWNLOAD_ID,
      },
    ],
    result: [
      {
        id: DOWNLOAD_ID,
      },
    ],
    unsupported: MESSAGES.downloads,
  },
  ...[
    [
      "approveDownload",
      "approve",
    ],
    [
      "cancelDownload",
      "cancel",
    ],
    [
      "pauseDownload",
      "pause",
    ],
    [
      "resumeDownload",
      "resume",
    ],
    [
      "forgetDownload",
      "forget",
    ],
  ].map(
    ([operation, method]): Row => ({
      operation: `windows.${operation}`,
      payload: {
        id: DOWNLOAD_ID,
      },
      calls: [
        [
          `downloads.${method}`,
          [
            DOWNLOAD_ID,
          ],
        ],
      ],
      result: null,
      unsupported: MESSAGES.downloads,
    }),
  ),
  {
    operation: "windows.getWebViewState",
    calls: [
      [
        "webview.getState",
        [],
      ],
    ],
    returns: {
      url: "https://app.bunaway.local/",
    },
    result: {
      url: "https://app.bunaway.local/",
    },
    unsupported: MESSAGES.webview,
  },
  {
    operation: "windows.navigateWebView",
    payload: {
      url: "https://app.bunaway.local/next",
    },
    calls: [
      [
        "webview.navigate",
        [
          "https://app.bunaway.local/next",
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.webview,
  },
  {
    operation: "windows.reloadWebView",
    payload: {},
    calls: [
      [
        "webview.reload",
        [
          false,
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.webview,
  },
  {
    operation: "windows.reloadWebView",
    payload: {
      ignoreCache: true,
    },
    calls: [
      [
        "webview.reload",
        [
          true,
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.webview,
  },
  command("stopWebView", MESSAGES.webview, "webview.stop"),
  {
    ...query("goBack", true, MESSAGES.webview),
    calls: [
      [
        "webview.goBack",
        [],
      ],
    ],
  },
  {
    ...query("goForward", false, MESSAGES.webview),
    calls: [
      [
        "webview.goForward",
        [],
      ],
    ],
  },
  {
    operation: "windows.setZoomFactor",
    payload: {
      factor: 1.5,
    },
    calls: [
      [
        "webview.setZoomFactor",
        [
          1.5,
        ],
      ],
    ],
    returns: 1.25,
    result: 1.25,
    unsupported: MESSAGES.webview,
  },
  command("openDevTools", MESSAGES.webview, "webview.openDevTools"),
  {
    operation: "windows.getWebViewAudioState",
    calls: [
      [
        "audio.getState",
        [],
      ],
    ],
    returns: {
      muted: true,
      playing: false,
    },
    result: {
      muted: true,
      playing: false,
    },
    unsupported: MESSAGES.audio,
  },
  {
    operation: "windows.setWebViewAudioMuted",
    payload: {
      muted: true,
    },
    calls: [
      [
        "audio.setMuted",
        [
          true,
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.audio,
  },
  query("getReadiness", {
    document: "ready",
    sdk: "ready",
  }),
  query("getSnapshot", {
    revision: 3,
  }),
  {
    operation: "windows.show",
    calls: [
      [
        "show",
        [
          true,
        ],
      ],
    ],
    result: null,
  },
  {
    operation: "windows.hide",
    calls: [
      [
        "show",
        [
          false,
        ],
      ],
    ],
    result: null,
  },
  command("showInactive"),
  {
    operation: "windows.focus",
    calls: [
      [
        "focus",
        [],
      ],
    ],
    returns: true,
    result: null,
  },
  query("activate", true),
  query("close", true),
  {
    operation: "windows.respondClose",
    payload: {
      requestId: 7,
      allow: true,
    },
    calls: [
      [
        "respondClose",
        [
          7,
          true,
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.close,
  },
  query("destroy", true, MESSAGES.relations),
  ...flag("setEnabled", "isEnabled", "enabled", MESSAGES.relations),
  ...flag("setFocusable", "isFocusable", "focusable", MESSAGES.focusability),
  query("getTitlebar", "custom", MESSAGES.display),
  ...flag("setAlwaysOnTop", "isAlwaysOnTop", "alwaysOnTop", MESSAGES.display),
  command("moveTop", MESSAGES.display),
  command("moveToBottom", MESSAGES.display),
  ...flag("setSkipTaskbar", "isSkipTaskbar", "skipTaskbar", MESSAGES.display),
  ...flag(
    "setContentProtection",
    "isContentProtected",
    "contentProtection",
    MESSAGES.display,
  ),
  {
    operation: "windows.requestAttention",
    calls: [
      [
        "requestAttention",
        [
          "untilFocused",
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.attention,
  },
  {
    operation: "windows.requestAttention",
    payload: {
      mode: "continuous",
    },
    calls: [
      [
        "requestAttention",
        [
          "continuous",
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.attention,
  },
  command("cancelAttention", MESSAGES.attention),
  ...flag("setMinimizable", "isMinimizable", "minimizable", MESSAGES.controls),
  ...flag("setMaximizable", "isMaximizable", "maximizable", MESSAGES.controls),
  ...flag("setClosable", "isClosable", "closable", MESSAGES.controls),
  ...flag(
    "setFullscreenable",
    "isFullscreenable",
    "fullscreenable",
    MESSAGES.fullscreenable,
  ),
  {
    operation: "windows.setOpacity",
    payload: {
      opacity: 0.5,
    },
    calls: [
      [
        "setOpacity",
        [
          0.5,
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.opacity,
  },
  query("getOpacity", 0.75, MESSAGES.opacity),
  ...flag("setHasShadow", "hasShadow", "hasShadow", MESSAGES.shadow),
  ...flag(
    "setRoundedCorners",
    "hasRoundedCorners",
    "roundedCorners",
    MESSAGES.roundedCorners,
  ),
  {
    operation: "windows.setBackgroundMaterial",
    payload: {
      material: "mica",
    },
    calls: [
      [
        "setBackgroundMaterial",
        [
          "mica",
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.backgroundMaterial,
  },
  query("getBackgroundMaterial", "acrylic", MESSAGES.backgroundMaterial),
  {
    operation: "windows.setBackgroundColor",
    payload: {
      color: "#ABC",
    },
    calls: [
      [
        "setBackgroundColor",
        [
          "#aabbcc",
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.backgroundColor,
  },
  query("getBackgroundColor", "#203040", MESSAGES.backgroundColor),
  {
    operation: "windows.setAccentColor",
    payload: {
      color: "#ABC",
    },
    calls: [
      [
        "setAccentColor",
        [
          "#aabbcc",
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.accentColor,
  },
  {
    operation: "windows.setAccentColor",
    payload: {
      color: null,
    },
    calls: [
      [
        "setAccentColor",
        [
          null,
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.accentColor,
  },
  query("getAccentColor", "#203040", MESSAGES.accentColor),
  ...flag(
    "setIgnoreMouseEvents",
    "isIgnoreMouseEvents",
    "ignore",
    MESSAGES.mouse,
  ),
  {
    operation: "windows.setTitle",
    payload: {
      title: "Title",
    },
    calls: [
      [
        "setTitle",
        [
          "Title",
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.title,
  },
  query("getTitle", "Title", MESSAGES.title),
  {
    operation: "windows.setAccessibleTitle",
    payload: {
      title: "Reader",
    },
    calls: [
      [
        "setAccessibleTitle",
        [
          "Reader",
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.title,
  },
  query("getAccessibleTitle", "Reader", MESSAGES.title),
  ...flag("setResizable", "isResizable", "resizable", MESSAGES.movement),
  ...flag("setMovable", "isMovable", "movable", MESSAGES.movement),
  {
    operation: "windows.setAspectRatio",
    payload: {
      ratio: 1.5,
    },
    calls: [
      [
        "setAspectRatio",
        [
          1.5,
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.aspect,
  },
  query("getAspectRatio", 1.5, MESSAGES.aspect),
  {
    operation: "windows.startDragging",
    calls: [
      [
        "startDragging",
        [],
      ],
    ],
    result: null,
    unsupported: MESSAGES.dragging,
  },
  {
    operation: "windows.startResizeDragging",
    payload: {
      direction: "northEast",
    },
    calls: [
      [
        "startResizeDragging",
        [
          "northEast",
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.dragging,
  },
  ...[
    "minimize",
    "maximize",
    "unmaximize",
    "restore",
    "toggleMaximize",
  ].map((name) => command(name, undefined, name, fullscreenCheck)),
  query("isMinimized", true),
  query("isMaximized", true),
  query("isFullscreen", true),
  query("isVisible", true),
  query("isFocused", true),
  {
    operation: "windows.isNormal",
    calls: [
      [
        "isMinimized",
        [],
      ],
      [
        "isMaximized",
        [],
      ],
      [
        "isFullscreen",
        [],
      ],
    ],
    result: true,
  },
  {
    operation: "windows.setSize",
    payload: {
      width: 640,
      height: 480,
    },
    calls: [
      ...fullscreenCheck,
      [
        "setSize",
        [
          640,
          480,
        ],
      ],
    ],
    result: null,
  },
  {
    operation: "windows.setPosition",
    payload: {
      x: 5,
      y: 6,
    },
    calls: [
      ...fullscreenCheck,
      [
        "setPosition",
        [
          5,
          6,
        ],
      ],
    ],
    result: null,
  },
  {
    operation: "windows.center",
    calls: [
      ...fullscreenCheck,
      [
        "center",
        [
          undefined,
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.center,
  },
  {
    operation: "windows.center",
    payload: {
      monitorId: "monitor-2",
    },
    calls: [
      ...fullscreenCheck,
      [
        "center",
        [
          "monitor-2",
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.center,
  },
  {
    operation: "windows.setFullscreen",
    payload: {
      fullscreen: true,
    },
    calls: [
      [
        "isFullscreenable",
        [],
      ],
      [
        "setFullscreen",
        [
          true,
        ],
      ],
    ],
    returns: true,
    result: null,
  },
  {
    operation: "windows.setFullscreen",
    payload: {
      fullscreen: false,
    },
    calls: [
      [
        "setFullscreen",
        [
          false,
        ],
      ],
    ],
    result: null,
  },
  {
    operation: "windows.setTaskbarProgress",
    payload: {
      state: "normal",
      value: 0.5,
    },
    calls: [
      [
        "setTaskbarProgress",
        [
          {
            state: "normal",
            value: 0.5,
          },
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.progress,
  },
  {
    operation: "windows.setThumbnailClip",
    payload: {
      region: {
        x: 1,
        y: 2,
        width: 3,
        height: 4,
      },
    },
    calls: [
      [
        "setThumbnailClip",
        [
          {
            x: 1,
            y: 2,
            width: 3,
            height: 4,
          },
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.clip,
  },
  {
    operation: "windows.setThumbnailToolTip",
    payload: {
      toolTip: "Tip",
    },
    calls: [
      [
        "setThumbnailToolTip",
        [
          "Tip",
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.tooltip,
  },
  {
    operation: "windows.setIcon",
    payload: {
      ico: null,
    },
    calls: [
      [
        "setIcon",
        [
          null,
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.icon,
  },
  query("hasCustomIcon", true, MESSAGES.icon),
  {
    operation: "windows.setOverlayIcon",
    payload: {
      ico: null,
      description: "Gone",
    },
    calls: [
      [
        "setOverlayIcon",
        [
          null,
          "Gone",
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.overlay,
  },
  {
    operation: "windows.setThumbnailToolbar",
    payload: {
      buttons: [],
    },
    calls: [
      [
        "setThumbnailToolbar",
        [
          [],
        ],
      ],
    ],
    result: null,
    unsupported: MESSAGES.toolbar,
  },
  {
    operation: "windows.setCloseConfirmation",
    payload: {
      message: "Sure?",
    },
    calls: [
      [
        "setCloseConfirmation",
        [
          "Sure?",
        ],
      ],
    ],
    result: null,
  },
  {
    operation: "windows.getOuterSize",
    calls: [
      [
        "getBounds",
        [
          "outer",
        ],
      ],
    ],
    returns: GEOMETRY,
    result: {
      width: 300,
      height: 400,
      dpi: 144,
    },
  },
  {
    operation: "windows.getContentPosition",
    calls: [
      [
        "getBounds",
        [
          "content",
        ],
      ],
    ],
    returns: GEOMETRY,
    result: {
      x: 10,
      y: 20,
      dpi: 144,
    },
  },
  {
    operation: "windows.getOuterBounds",
    calls: [
      [
        "getBounds",
        [
          "outer",
        ],
      ],
    ],
    returns: GEOMETRY,
    result: GEOMETRY,
  },
  {
    operation: "windows.getNormalBounds",
    calls: [
      [
        "getBounds",
        [
          "normal",
        ],
      ],
    ],
    returns: GEOMETRY,
    result: GEOMETRY,
  },
  {
    operation: "windows.getContentSize",
    payload: {
      unit: "logical",
    },
    calls: [
      [
        "getBounds",
        [
          "content",
        ],
      ],
    ],
    returns: GEOMETRY,
    result: {
      width: 200,
      height: 267,
      dpi: 144,
    },
  },
  {
    operation: "windows.getContentBounds",
    payload: {
      unit: "logical",
    },
    calls: [
      [
        "getBounds",
        [
          "content",
        ],
      ],
    ],
    returns: GEOMETRY,
    result: {
      x: 7,
      y: 13,
      width: 200,
      height: 267,
      dpi: 144,
    },
  },
  {
    operation: "windows.toLogical",
    payload: {
      value: {
        x: 144,
        y: 288,
      },
    },
    calls: [
      [
        "getDpi",
        [],
      ],
    ],
    returns: 144,
    result: {
      value: {
        x: 96,
        y: 192,
      },
      dpi: 144,
    },
  },
  {
    operation: "windows.toPhysical",
    payload: {
      value: {
        width: 96,
        height: 48,
      },
    },
    calls: [
      [
        "getDpi",
        [],
      ],
    ],
    returns: 144,
    result: {
      value: {
        width: 144,
        height: 72,
      },
      dpi: 144,
    },
  },
  {
    operation: "windows.setOuterBounds",
    payload: {
      x: 1,
      y: 2,
      width: 300,
      height: 400,
    },
    calls: [
      ...fullscreenCheck,
      [
        "setGeometry",
        [
          "outer",
          {
            x: 1,
            y: 2,
            width: 300,
            height: 400,
          },
        ],
      ],
    ],
    result: null,
  },
  {
    operation: "windows.setContentPosition",
    payload: {
      unit: "logical",
      x: 96,
      y: 48,
    },
    calls: [
      ...fullscreenCheck,
      [
        "getDpi",
        [],
      ],
      [
        "setGeometry",
        [
          "content",
          {
            x: 144,
            y: 72,
          },
        ],
      ],
    ],
    returnsBy: {
      getDpi: 144,
    },
    result: null,
  },
];

const CONSTRAINTS = {
  minWidth: 250,
  minHeight: 260,
  maxWidth: 800,
  maxHeight: 900,
};

type Fixture = ReturnType<typeof fixture>;

/** Wire input: an operation without data takes null, one with optional fields may take `{}`. */
function requestInput(
  operation: string,
  payload: Record<string, unknown> | null,
) {
  const empty = !payload || Object.keys(payload).length === 0;
  if (
    empty &&
    operation in windowOperations &&
    windowOperations[operation as WindowOperation].input.safeParse(null).success
  ) {
    return null;
  }
  return {
    ...payload,
  };
}

/** Build a recording native window and the services around it. */
function fixture(
  options: {
    bare?: boolean;
    returns?: Record<string, unknown>;
    permissions?: string[];
    services?: Partial<NativeWindowServices>;
    windows?: Record<string, Partial<NativeWindow>>;
  } = {},
) {
  const calls: Call[] = [];
  const returns: Record<string, unknown> = {
    isFullscreen: false,
    isFullscreenable: true,
    isMinimized: false,
    isMaximized: false,
    isVisible: true,
    isFocused: true,
    focus: true,
    getDpi: 96,
    getBounds: GEOMETRY,
    getSizeConstraints: CONSTRAINTS,
    getReadiness: {
      document: "ready",
      sdk: "ready",
    },
    ...options.returns,
  };
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([
        name,
        args,
      ]);
      return returns[name];
    };
  const required = [
    "getSnapshot",
    "getReadiness",
    "show",
    "showInactive",
    "focus",
    "activate",
    "close",
    "minimize",
    "maximize",
    "unmaximize",
    "restore",
    "toggleMaximize",
    "isMinimized",
    "isMaximized",
    "isFullscreen",
    "getBounds",
    "getDpi",
    "isVisible",
    "isFocused",
    "getSizeConstraints",
    "setSizeConstraints",
    "setSize",
    "setPosition",
    "setGeometry",
    "setFullscreen",
    "setCloseConfirmation",
  ];
  const optional = [
    "getMonitor",
    "showPrintUI",
    "respondClose",
    "destroy",
    "setParent",
    "getParent",
    "getChildren",
    "setEnabled",
    "isEnabled",
    "setFocusable",
    "isFocusable",
    "getTitlebar",
    "setAlwaysOnTop",
    "isAlwaysOnTop",
    "moveTop",
    "moveToBottom",
    "setSkipTaskbar",
    "isSkipTaskbar",
    "setContentProtection",
    "isContentProtected",
    "requestAttention",
    "cancelAttention",
    "setMinimizable",
    "isMinimizable",
    "setMaximizable",
    "isMaximizable",
    "setFullscreenable",
    "isFullscreenable",
    "setOpacity",
    "getOpacity",
    "setHasShadow",
    "hasShadow",
    "setRoundedCorners",
    "hasRoundedCorners",
    "setBackgroundMaterial",
    "getBackgroundMaterial",
    "setBackgroundColor",
    "getBackgroundColor",
    "setAccentColor",
    "getAccentColor",
    "setIgnoreMouseEvents",
    "isIgnoreMouseEvents",
    "setClosable",
    "isClosable",
    "setTitle",
    "getTitle",
    "setAccessibleTitle",
    "getAccessibleTitle",
    "setResizable",
    "isResizable",
    "setMovable",
    "isMovable",
    "setAspectRatio",
    "getAspectRatio",
    "startDragging",
    "startResizeDragging",
    "center",
    "setTaskbarProgress",
    "setThumbnailClip",
    "setThumbnailToolTip",
    "setOverlayIcon",
    "setThumbnailToolbar",
    "setIcon",
    "hasCustomIcon",
  ];
  const groups = {
    downloads: [
      "setRequestsEnabled",
      "list",
      "approve",
      "cancel",
      "pause",
      "resume",
      "forget",
    ],
    webview: [
      "getState",
      "navigate",
      "reload",
      "stop",
      "goBack",
      "goForward",
      "setZoomFactor",
      "openDevTools",
    ],
    audio: [
      "getState",
      "setMuted",
    ],
  };
  const native: Record<string, unknown> = {};
  for (const name of options.bare
    ? required
    : [
        ...required,
        ...optional,
      ]) {
    native[name] = record(name);
  }
  if (!options.bare) {
    for (const [group, methods] of Object.entries(groups)) {
      native[group] = Object.fromEntries(
        methods.map((method) => [
          method,
          record(`${group}.${method}`),
        ]),
      );
    }
  }
  const specs = [
    "main",
  ].map((view) => ({
    view,
    home: "https://app.bunaway.local/index.html",
    title: view,
    window: {
      width: 800,
      height: 600,
    },
  }));
  const unused = (): never => {
    throw new Error("Unexpected native service call");
  };
  const closed: Array<
    [
      string,
      boolean | undefined,
    ]
  > = [];
  const services = {
    specs,
    read: () => ({
      closed: false,
      cleaned: false,
      ready: true,
      failure: undefined,
      deadline: Infinity,
    }),
    create: unused,
    close: (view: string, replacing?: boolean) => {
      closed.push([
        view,
        replacing,
      ]);
      return true;
    },
    window: (key: string) =>
      ({
        ...native,
        ...options.windows?.[key],
      }) as unknown as NativeWindow,
    stopping: () => false,
    cancelled: () => false,
    now: Date.now,
    tick: async () => {},
    ...options.services,
  } satisfies NativeWindowServices;
  const adapter = createOperations({
    dataRoot: ".",
    capabilities: [],
    windows: services,
  });
  const invoke = (
    operation: string,
    payload: Record<string, unknown> | null = {},
    source = "backend",
    permissions = options.permissions ?? [
      operation,
    ],
  ) => {
    if (!adapter.executeUI) {
      throw new Error("Missing UI adapter");
    }
    const input = requestInput(operation, payload);
    return adapter.executeUI(operation, input as JsonValue, source, {
      requestId: "request-1",
      permissions: {
        permissions,
      },
    });
  };
  return {
    calls,
    closed,
    returns,
    invoke,
  };
}

const rejects = (
  promise: Promise<unknown> | unknown,
  code: string,
  message: unknown,
) =>
  expect(Promise.resolve(promise)).rejects.toMatchObject({
    code,
    message,
  });

test("each window operation reaches its native control with the documented arguments", async () => {
  for (const row of rows) {
    const f = fixture({
      returns:
        row.returnsBy ?? (row.returns === undefined ? {} : returnsFor(row)),
    });
    const result = await f.invoke(row.operation, row.payload);
    expect<unknown>({
      operation: row.operation,
      payload: row.payload,
      calls: f.calls,
      result,
    }).toEqual({
      operation: row.operation,
      payload: row.payload,
      calls: row.calls,
      result: row.result,
    });
  }
});

/** Route a row's native return value to the control that its final call names. */
function returnsFor(row: Row): Record<string, unknown> {
  const last = row.calls.at(-1);
  return last
    ? {
        [last[0]]: row.returns,
      }
    : {};
}

test("a platform without an optional control reports UNSUPPORTED with its own message", async () => {
  for (const row of rows) {
    if (!row.unsupported) {
      continue;
    }
    const f = fixture({
      bare: true,
    });
    await rejects(
      f.invoke(row.operation, row.payload),
      "UNSUPPORTED",
      row.unsupported,
    );
  }
});

test("fullscreen blocks state, size and geometry changes without touching the native window", async () => {
  const operations: Array<
    [
      string,
      Record<string, unknown>,
      string,
    ]
  > = [
    [
      "windows.minimize",
      {},
      "Exit fullscreen before changing window state.",
    ],
    [
      "windows.maximize",
      {},
      "Exit fullscreen before changing window state.",
    ],
    [
      "windows.unmaximize",
      {},
      "Exit fullscreen before changing window state.",
    ],
    [
      "windows.restore",
      {},
      "Exit fullscreen before changing window state.",
    ],
    [
      "windows.toggleMaximize",
      {},
      "Exit fullscreen before changing window state.",
    ],
    [
      "windows.setSize",
      {
        width: 640,
        height: 480,
      },
      "Exit fullscreen before changing size.",
    ],
    [
      "windows.setPosition",
      {
        x: 1,
        y: 2,
      },
      "Exit fullscreen before changing position.",
    ],
    [
      "windows.center",
      {},
      "Exit fullscreen before centering the window.",
    ],
    [
      "windows.setContentPosition",
      {
        x: 1,
        y: 2,
      },
      "Exit fullscreen before changing window geometry.",
    ],
    [
      "windows.setOuterSize",
      {
        width: 300,
        height: 400,
      },
      "Exit fullscreen before changing window geometry.",
    ],
    [
      "windows.setContentBounds",
      {
        x: 1,
        y: 2,
        width: 300,
        height: 400,
      },
      "Exit fullscreen before changing window geometry.",
    ],
    [
      "windows.setOuterBounds",
      {
        x: 1,
        y: 2,
        width: 300,
        height: 400,
      },
      "Exit fullscreen before changing window geometry.",
    ],
  ];
  for (const [operation, payload, message] of operations) {
    const f = fixture({
      returns: {
        isFullscreen: true,
      },
    });
    await rejects(f.invoke(operation, payload), "INVALID_ARGUMENT", message);
    expect(f.calls).toEqual([
      [
        "isFullscreen",
        [],
      ],
    ]);
  }
});

test("entering fullscreen needs a fullscreenable window but leaving never does", async () => {
  const blocked = fixture({
    returns: {
      isFullscreenable: false,
    },
  });
  await rejects(
    blocked.invoke("windows.setFullscreen", {
      fullscreen: true,
    }),
    "INVALID_ARGUMENT",
    "The window is not fullscreenable.",
  );
  expect(blocked.calls).toEqual([
    [
      "isFullscreenable",
      [],
    ],
  ]);
  const leaving = fixture({
    returns: {
      isFullscreenable: false,
    },
  });
  await leaving.invoke("windows.setFullscreen", {
    fullscreen: false,
  });
  expect(leaving.calls).toEqual([
    [
      "setFullscreen",
      [
        false,
      ],
    ],
  ]);
  // A platform that cannot report fullscreenability allows entering.
  const bare = fixture({
    bare: true,
  });
  await bare.invoke("windows.setFullscreen", {
    fullscreen: true,
  });
  expect(bare.calls).toEqual([
    [
      "setFullscreen",
      [
        true,
      ],
    ],
  ]);
});

test("size limits are read as pairs and validated as a whole before they are applied", async () => {
  const f = fixture();
  expect(await f.invoke("windows.getMinSize")).toEqual({
    width: 250,
    height: 260,
  });
  expect(await f.invoke("windows.getMaxSize")).toEqual({
    width: 800,
    height: 900,
  });
  expect(await f.invoke("windows.getSizeConstraints")).toEqual(CONSTRAINTS);
  f.calls.length = 0;
  await f.invoke("windows.setMinSize", {
    width: 300,
    height: 310,
  });
  await f.invoke("windows.setMaxSize", {
    width: 700,
    height: 710,
  });
  await f.invoke("windows.setSizeConstraints", {
    minWidth: 300,
  });
  expect(f.calls.filter(([name]) => name === "setSizeConstraints")).toEqual([
    [
      "setSizeConstraints",
      [
        {
          minWidth: 300,
          minHeight: 310,
          maxWidth: 800,
          maxHeight: 900,
        },
      ],
    ],
    [
      "setSizeConstraints",
      [
        {
          minWidth: 250,
          minHeight: 260,
          maxWidth: 700,
          maxHeight: 710,
        },
      ],
    ],
    [
      "setSizeConstraints",
      [
        {
          minWidth: 300,
          minHeight: null,
          maxWidth: null,
          maxHeight: null,
        },
      ],
    ],
  ]);
  f.calls.length = 0;
  await rejects(
    f.invoke("windows.setMinSize", {
      width: 900,
      height: 310,
    }),
    "INVALID_ARGUMENT",
    "Minimum window size cannot exceed the maximum size.",
  );
  await rejects(
    f.invoke("windows.setMaxSize", {
      width: 220,
      height: 710,
    }),
    "INVALID_ARGUMENT",
    "Maximum window size cannot be smaller than the minimum size.",
  );
  await rejects(
    f.invoke("windows.setSizeConstraints", {
      minWidth: 900,
      maxWidth: 300,
    }),
    "INVALID_ARGUMENT",
    "Minimum window size cannot exceed the maximum size.",
  );
  expect(f.calls.some(([name]) => name === "setSizeConstraints")).toBe(false);
});

test("a taskbar overlay is validated by the icon provider before any native call", async () => {
  const f = fixture();
  await rejects(
    f.invoke("windows.setOverlayIcon", {
      ico: "AAAA",
      description: "x",
    }),
    "INVALID_ARGUMENT",
    expect.any(String),
  );
  expect(f.calls).toEqual([]);
});

test("only the backend or the asked document answers a close request", async () => {
  const caller = (viewId: string): Partial<NativeWindowServices> => ({
    lookup: {
      byId: () => null,
      byView: () => null,
      byRequest: () => ({
        windowId: `w-${viewId}`,
        viewId,
      }),
      focused: () => null,
      lastActive: () => null,
    },
  });
  const answer = {
    requestId: 7,
    allow: false,
  };
  const own = fixture({
    services: caller("main"),
  });
  await own.invoke("windows.respondClose", answer, "view:main");
  expect(own.calls).toEqual([
    [
      "respondClose",
      [
        7,
        false,
      ],
    ],
  ]);
  await fixture().invoke("windows.respondClose", answer, "backend");
  for (const [source, services] of [
    [
      "view:editor",
      caller("editor"),
    ],
    [
      "view:main",
      caller("editor"),
    ],
    [
      "view:main",
      {},
    ],
    [
      "view:other",
      caller("main"),
    ],
  ] as const) {
    const f = fixture({
      services,
    });
    await rejects(
      f.invoke("windows.respondClose", answer, source),
      "PERMISSION_DENIED",
      "Close requests are answered only by the asked window's document or the backend.",
    );
    expect(f.calls).toEqual([]);
  }
});

test("monitor queries need their grant, honor cancellation and report missing services", async () => {
  const monitor = {
    id: "m1",
  };
  const services = {
    monitors: {
      list: () => [
        monitor,
      ],
      primary: () => monitor,
      nearestPoint: () => monitor,
      nearestRect: () => monitor,
      cursor: () => ({
        x: 1,
        y: 2,
      }),
    },
  } as unknown as Partial<NativeWindowServices>;
  const one = (operation: string, payload: Record<string, unknown> = {}) =>
    fixture({
      services,
      permissions: [
        operation,
      ],
    }).invoke(operation, payload);
  expect(await one("windows.getMonitors")).toEqual([
    monitor,
  ]);
  expect(await one("windows.getPrimaryMonitor")).toEqual(monitor);
  expect(
    await one("windows.getMonitorNearestPoint", {
      x: 1,
      y: 2,
    }),
  ).toEqual(monitor);
  expect(
    await one("windows.getMonitorNearestRect", {
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    }),
  ).toEqual(monitor);
  expect(await one("windows.getCursorPosition")).toEqual({
    x: 1,
    y: 2,
  });
  await rejects(
    fixture({
      services,
      permissions: [],
    }).invoke("windows.getMonitors"),
    "PERMISSION_DENIED",
    "Monitor query permission required.",
  );
  await rejects(
    fixture({
      services: {
        ...services,
        stopping: () => true,
      },
      permissions: [
        "windows.getMonitors",
      ],
    }).invoke("windows.getMonitors"),
    "CANCELLED",
    "Monitor query cancelled.",
  );
  await rejects(
    fixture({
      permissions: [
        "windows.getMonitors",
      ],
    }).invoke("windows.getMonitors"),
    "UNSUPPORTED",
    MESSAGES.monitor,
  );
  await rejects(
    fixture({
      services,
      permissions: [
        "windows.getMonitorSnapshot",
      ],
    }).invoke("windows.getMonitorSnapshot"),
    "UNSUPPORTED",
    "Monitor events are unavailable.",
  );
});

test("only the backend waits for window lifecycle phases, with no grant", async () => {
  const f: Fixture = fixture();
  await rejects(
    f.invoke("windows.waitForLifecycle", {}, "view:main"),
    "PERMISSION_DENIED",
    "Window lifecycle subscription requires the backend.",
  );
  await rejects(
    f.invoke("windows.waitForLifecycle", {}, "backend", []),
    "UNSUPPORTED",
    "Window lifecycle notification is not available.",
  );
});

test("only the backend waits for WebView process failures, with no grant", async () => {
  const f: Fixture = fixture();
  await rejects(
    f.invoke("windows.waitForProcessFailure", {}, "view:main"),
    "PERMISSION_DENIED",
    "WebView process failure subscription requires the backend.",
  );
  await rejects(
    f.invoke("windows.waitForProcessFailure", {}, "backend", []),
    "UNSUPPORTED",
    "WebView process failure notification is not available.",
  );
});

test("only the backend waits for WebView audio changes, with no grant", async () => {
  const f: Fixture = fixture();
  await rejects(
    f.invoke("windows.waitForAudioChange", {}, "view:main"),
    "PERMISSION_DENIED",
    "WebView audio subscription requires the backend.",
  );
  await rejects(
    f.invoke("windows.waitForAudioChange", {}, "backend", []),
    "UNSUPPORTED",
    "WebView audio change notification is not available.",
  );
});

test("an unknown native operation is rejected", () => {
  const f: Fixture = fixture();
  return rejects(
    f.invoke("windows.unknown"),
    "INVALID_ARGUMENT",
    expect.any(String),
  );
});
