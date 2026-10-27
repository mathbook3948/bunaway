import { MAX_MESSAGE_BYTES } from "@bunaway/protocol";

export type { NativeIcoFrame } from "./native-ico.ts";
export {
  MAX_NATIVE_ICO_BYTES,
  parseNativeIco,
  selectNativeIcoFrame,
} from "./native-ico.ts";
export type {
  NativeMenuEditRole,
  NativeMenuItem,
  NativeMenuRole,
  NativeMenuServices,
  NativeMenuWindowHost,
  NativeMenuWindowRole,
} from "./native-menu.ts";
export type { NativeShortcutServices } from "./native-shortcut.ts";
export type {
  NativeTrayEvent,
  NativeTrayInitialization,
  NativeTrayOwner,
  NativeTrayServices,
  NativeTraySnapshot,
  NativeTrayWindowHost,
} from "./native-tray.ts";
export {
  MAX_TRAY_ICO_BYTES,
  MAX_TRAY_TOOLTIP_UNITS,
  MAX_TRAY_WAITERS,
} from "./native-tray.ts";

/** Inclusive accepted dimension range for window sizes. */
export const MIN_WINDOW_DIMENSION = 200;
export const MAX_WINDOW_DIMENSION = 8192;

/** Native integers (Win32 geometry, sizes and identifiers) are signed 32-bit. */
export const INT32_MIN = -2147483648;
export const INT32_MAX = 2147483647;

/** Win32 screen geometry uses signed 32-bit components. */
export const MIN_WINDOW_COORDINATE = INT32_MIN;
export const MAX_WINDOW_COORDINATE = INT32_MAX;

/** Initial outer screen position and logical size interpretation. Windows only. */
export type WindowPlacement = {
  /** Physical outer coordinates. Supply both; null clears a declared position. */
  x?: number | null;
  y?: number | null;
  /** Center the outer rectangle in the primary work area. Conflicts with x/y. */
  center?: boolean;
  /** Interpret width/height as content dimensions by default, or outer when false. */
  useContentSize?: boolean;
  /** Shrink and move the initial outer rectangle into the selected work area. */
  preventOverflow?: boolean;
};

/** Validate merged placement before reserving resources or closing an existing window. */
export function hasValidWindowPlacement<
  T extends {
    x?: unknown;
    y?: unknown;
    center?: unknown;
    useContentSize?: unknown;
    preventOverflow?: unknown;
  },
>(value: T): value is T & WindowPlacement {
  const coordinate = (position: unknown) =>
    position === undefined ||
    position === null ||
    (typeof position === "number" &&
      Number.isInteger(position) &&
      position >= MIN_WINDOW_COORDINATE &&
      position <= MAX_WINDOW_COORDINATE);
  return (
    coordinate(value.x) &&
    coordinate(value.y) &&
    (value.x == null) === (value.y == null) &&
    (value.center !== true || value.x == null) &&
    [
      value.center,
      value.useContentSize,
      value.preventOverflow,
    ].every((option) => option === undefined || typeof option === "boolean")
  );
}

/**
 * Taskbar flash duration: `untilFocused` stops when the window becomes the
 * foreground window, `continuous` runs until `cancelAttention`.
 */
export type WindowAttentionMode = "untilFocused" | "continuous";

/** Edge or corner grabbed by `startResizeDragging`. */
export type WindowResizeDirection =
  | "north"
  | "south"
  | "east"
  | "west"
  | "northEast"
  | "northWest"
  | "southEast"
  | "southWest";

/** Optional inclusive lower and upper bounds for a window's width and height. */
export type WindowSizeConstraints = {
  minWidth: number | null;
  minHeight: number | null;
  maxWidth: number | null;
  maxHeight: number | null;
};

/** Smallest and largest accepted width / height aspect ratio, so one axis cannot collapse. */
export const MIN_WINDOW_ASPECT_RATIO = 0.1;
export const MAX_WINDOW_ASPECT_RATIO = 10;

/** Checks that a ratio is null (no lock) or a finite number within the supported range. */
export function isWindowAspectRatio(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      value >= MIN_WINDOW_ASPECT_RATIO &&
      value <= MAX_WINDOW_ASPECT_RATIO)
  );
}

/**
 * Why a window declaration cannot be transparent, or undefined when it can. A native title bar
 * is always drawn opaque, and a background color would hide the desktop the declaration asks for.
 */
export function transparentWindowError(window: {
  transparent?: boolean | undefined;
  titlebar?: string | undefined;
  backgroundColor?: unknown;
}): string | undefined {
  if (window.transparent !== true) {
    return undefined;
  }
  if (window.titlebar !== "custom") {
    return 'A transparent window requires titlebar "custom".';
  }
  if (window.backgroundColor !== undefined) {
    return "A transparent window cannot declare backgroundColor.";
  }
  return undefined;
}

/** An opaque window background color: `#RGB` or `#RRGGBB`. Alpha forms are rejected because their byte order differs between CSS and Electron. */
export const WINDOW_BACKGROUND_COLOR_PATTERN =
  /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$(?![\s\S])/;

/** Expands a valid background color to lowercase `#rrggbb`; undefined when the text is not one. */
export function normalizeWindowBackgroundColor(
  value: unknown,
): string | undefined {
  if (
    typeof value !== "string" ||
    !WINDOW_BACKGROUND_COLOR_PATTERN.test(value)
  ) {
    return undefined;
  }
  const digits = value.slice(1).toLowerCase();
  return digits.length === 3
    ? `#${[
        ...digits,
      ]
        .map((digit) => digit + digit)
        .join("")}`
    : `#${digits}`;
}

/** Checks that a constraint is null or an integer within the supported dimension range. */
export function isWindowSizeDimension(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isInteger(value) &&
      value >= MIN_WINDOW_DIMENSION &&
      value <= MAX_WINDOW_DIMENSION)
  );
}

/** Checks every bound and ensures each minimum does not exceed its maximum. */
export function hasValidWindowSizeConstraints(
  constraints: WindowSizeConstraints,
): boolean {
  return (
    isWindowSizeDimension(constraints.minWidth) &&
    isWindowSizeDimension(constraints.minHeight) &&
    isWindowSizeDimension(constraints.maxWidth) &&
    isWindowSizeDimension(constraints.maxHeight) &&
    (constraints.minWidth === null ||
      constraints.maxWidth === null ||
      constraints.minWidth <= constraints.maxWidth) &&
    (constraints.minHeight === null ||
      constraints.maxHeight === null ||
      constraints.minHeight <= constraints.maxHeight)
  );
}

/** Clamps a requested size to the configured bounds; null bounds are unbounded. */
export function clampWindowSize(
  width: number,
  height: number,
  constraints: WindowSizeConstraints,
): {
  width: number;
  height: number;
} {
  return {
    width: Math.max(
      constraints.minWidth ?? Number.NEGATIVE_INFINITY,
      Math.min(constraints.maxWidth ?? Number.POSITIVE_INFINITY, width),
    ),
    height: Math.max(
      constraints.minHeight ?? Number.NEGATIVE_INFINITY,
      Math.min(constraints.maxHeight ?? Number.POSITIVE_INFINITY, height),
    ),
  };
}

/** Upper bound for per-window host queues and ID tables. */
export const MAX_WINDOWS = 128;

/** Validated definition of a screen, policy and window defaults. */
export type WindowSpec = {
  /** Unique declared policy view served by every instance. */
  view: string;
  /** Initial URL, restricted by the view's allowed origin. */
  home: string;
  /** Native window title. */
  title: string;
  /** Initial 96-DPI logical content dimensions by default; limits always constrain content. */
  window: WindowPlacement & {
    width: number;
    height: number;
    minWidth?: number | null;
    minHeight?: number | null;
    maxWidth?: number | null;
    maxHeight?: number | null;
    /** Permit user and host foreground activation, default true. Windows false uses WS_EX_NOACTIVATE. */
    focusable?: boolean;
    /** System caption by default. Custom uses CSS app-region drag/no-drag and retains native resize borders. Windows only. */
    titlebar?: "system" | "custom";
    /** Place above ordinary windows without activation, default false. Windows only. */
    alwaysOnTop?: boolean;
    /** Hide from the taskbar and Alt+Tab using tool-window style, default false. Windows only. */
    skipTaskbar?: boolean;
    /** Exclude the window from screenshots and screen sharing, default false. Windows and macOS. */
    contentProtection?: boolean;
    /** Opaque `#RGB` or `#RRGGBB` color shown behind and before the document; absent keeps the system color and the WebView default. Windows only. */
    backgroundColor?: string;
    /** Let the desktop show through the parts of the page that are not painted, default false. Requires `titlebar: "custom"` and excludes `backgroundColor`. Windows only. */
    transparent?: boolean;
    /** ICO path relative to the app resources directory, applied when the window is created; absent keeps the executable icon. Windows only. */
    icon?: string;
    /** Start maximized, retaining the initial normal placement for restoration. Windows only. */
    maximized?: boolean;
    /** Start fullscreen. When combined with maximized, exit restores maximized state. Windows only. */
    fullscreen?: boolean;
  };
  /** Whether the runtime creates one instance of this definition during startup. */
  startup?: boolean;
  /** Initial visibility, default true. Hidden creation never activates the window. */
  visible?: boolean;
  /** Create hidden and show once after the document, or document and SDK, are ready. */
  showWhenReady?: "document" | "sdk";
};

/** Current-document preparation. SDK readiness is an acknowledged protocol session, not app data or rendering. */
export type WindowReadiness = {
  windowId: string;
  viewId: string;
  /** Existing session-boundary generation; navigation and session revocation advance it. */
  documentGeneration: number;
  /** Increases within this HWND lifetime, including resets and terminal outcomes. */
  revision: number;
  /** Creation completed for this HWND lifetime; closing does not erase that fact. */
  nativeCreated: boolean;
  document: "pending" | "ready" | "failed" | "cancelled";
  sdk: "pending" | "ready" | "failed" | "cancelled";
  /** Latest preparation or session error; navigation clears it, SDK reconnect retains it for a failed/cancelled document. */
  error: import("@bunaway/protocol").WireError | null;
};
/** Lifecycle state observed while a native window is created or replaced. */
export type WindowState = {
  /** Whether closing has committed for this window. */
  closed: boolean;
  /** Whether its native and WebView resources have been released. */
  cleaned: boolean;
  /** Whether WebView setup is complete; document and SDK readiness are separate. */
  ready: boolean;
  /** Failure captured during creation, when one occurred. */
  failure: unknown;
  /** A parent ended this lifetime; an in-flight live-window replacement must not reopen it. */
  replacementCancelled?: boolean;
  /** Absolute deadline in milliseconds while waiting for creation to finish. */
  deadline: number;
};
/** Physical screen rectangle and the DPI used to measure or project it. */
export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** DPI used for this physical screen-coordinate snapshot. */
  dpi: number;
};

/** One phase of a window lifetime, as published by `windows.lifecycle`. */
export type WindowLifecycleEvent = {
  windowId: string;
  viewId: string;
  phase: "created" | "ready" | "closed" | "destroyed";
};

/** Which WebView2 process failed, as named by `windows.waitForProcessFailure`. */
export type WindowProcessFailureKind =
  | "browser-exited"
  | "renderer-exited"
  | "renderer-unresponsive"
  | "frame-renderer-exited"
  | "utility-exited"
  | "sandbox-helper-exited"
  | "gpu-exited"
  | "plugin-exited"
  | "plugin-broker-exited"
  | "unknown-exited";

/** One WebView process failure and what the host did about it. */
export type WindowProcessFailureEvent = {
  windowId: string;
  viewId: string;
  kind: WindowProcessFailureKind;
  /** `reload` navigates the view again in the same window; `close` closes the window. */
  recovery: "reload" | "close";
};

/** A WebView's audio state after a change, as published by `windows.waitForAudioChange`. */
export type WindowAudioChangeEvent = {
  windowId: string;
  viewId: string;
  muted: boolean;
  /** Whether the document is playing audio, independent of `muted`. */
  playing: boolean;
};

/** A current desktop display snapshot. IDs are device names, not persistent hardware identities. */
export type NativeMonitor = {
  id: string;
  name: string;
  primary: boolean;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  workArea: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  dpi: number;
  scaleFactor: number;
  /** Counter-clockwise degrees from the natural orientation, or null when the driver does not report orientation. */
  rotation: 0 | 90 | 180 | 270 | null;
  /** Integer hertz reported by DEVMODE, or null for driver default/unknown. */
  refreshRate: number | null;
};

/** Last observed display state. An error retains the last known monitors rather than inventing data. */
export type NativeMonitorSnapshot = {
  sourceId: string;
  revision: number;
  monitors: NativeMonitor[];
  error: import("@bunaway/protocol").WireError | null;
};
/** Lightweight display transition; query the snapshot to recover full metrics. */
export type NativeMonitorChange = {
  sourceId: string;
  revision: number;
  added: string[];
  removed: string[];
  changed: string[];
  error: import("@bunaway/protocol").WireError | null;
};

/** Display queries executed on the per-monitor-aware UI thread. No native handles escape. */
export type NativeMonitorServices = {
  /** Read a fresh, versioned observation. Absent on older hosts without display events. */
  snapshot?(): NativeMonitorSnapshot;
  list(): NativeMonitor[];
  primary(): NativeMonitor;
  nearestPoint(point: { x: number; y: number }): NativeMonitor;
  nearestRect(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): NativeMonitor;
  cursor(): {
    x: number;
    y: number;
  };
};

/**
 * Creates the HICON for a taskbar overlay at `sizePx` pixels. The host calls it each time it applies the
 * overlay (on the call and when Explorer recreates the taskbar button) with the window's current small
 * icon size, and takes ownership of the returned handle: it destroys the handle when the overlay is
 * replaced, removed or the window is destroyed, or immediately when the shell rejects it. A provider
 * that cannot build an icon throws, for example INVALID_ARGUMENT, and the host keeps the current overlay.
 */
export type NativeOverlayIconProvider = (sizePx: number) => bigint;

/** Taskbar thumbnail toolbar slots Windows provides per window (`ITaskbarList3::ThumbBarAddButtons`). */
export const NATIVE_THUMBNAIL_BUTTON_LIMIT = 7;

/** Behavior flags of a thumbnail toolbar button; `enabled` and `disabled` are mutually exclusive. */
export type NativeThumbnailButtonFlag =
  | "enabled"
  | "disabled"
  | "dismissonclick"
  | "nobackground"
  | "hidden"
  | "noninteractive";

/** One thumbnail toolbar button; `id` is the app-chosen name reported when the button is pressed. */
export type NativeThumbnailButton = {
  id: string;
  icon: NativeOverlayIconProvider;
  tooltip: string;
  flags: readonly NativeThumbnailButtonFlag[];
};

/**
 * Native controls exposed to an installed window plugin.
 * The plugin rejects minimized/maximized transitions during fullscreen before invoking these controls.
 * Native failures throw; the UI host converts them to bounded public errors.
 */
export type NativeWindow = {
  /** Largest overlap, or nearest display; minimized windows use their pre-minimize rectangle. */
  getMonitor?(): NativeMonitor;
  /** Requests a user-controlled browser or system print dialog; does not report print completion. */
  showPrintUI?(kind: "browser" | "system"): void;
  /** Trusted-backend download approval and lifetime controls. Windows only. */
  downloads?: NativeDownloads;
  /** Single host-owned WebView controls. Absent on platforms without this service. */
  webview?: NativeWebView;
  /** Audio controls for this window's WebView controller. Windows only. */
  audio?: NativeWebViewAudio;
  /** Reads a versioned state and physical outer-bounds snapshot for recovery after subscribing. */
  getSnapshot(): WindowSnapshot;
  /** Reads the latest preparation outcome, including a retained closed-window outcome. */
  getReadiness(): WindowReadiness;
  /** Shows or hides the native window. */
  show(visible: boolean): void;
  /** Shows without activation, preserving normal, minimized or maximized state and other input focus. */
  showInactive(): void;
  /** Focuses the window and reports whether the request succeeded. */
  focus(): boolean;
  /** Activates only an already visible, non-minimized window; returns its observed foreground state. */
  activate(): boolean;
  /** Starts a normal close request; returns false when it is declined or hides to tray. */
  close(): boolean | Promise<boolean>;
  /**
   * Answers the pending `windows.closeRequested` question of this window. `allow: true` lets the
   * close continue and replaces only this window's own close confirmation; `false` keeps the window open.
   * Throws INVALID_ARGUMENT when `requestId` is not the pending request. The platform adapter admits
   * only the trusted backend and this window's own document as callers. Windows and macOS; macOS has
   * no close confirmation, so `allow: true` there only continues the close order.
   */
  respondClose?(requestId: number, allow: boolean): void;
  /** Trusted backend destruction bypasses confirmation, tray hiding and quit veto. Windows only. */
  destroy?(): boolean | Promise<boolean>;
  /** Sets the owner of this top-level window by native lifetime ID. Null detaches. Windows only. */
  setParent?(windowId: string | null, modal: boolean): void;
  /** Returns the owner identity, or null when unowned. Windows only. */
  getParent?(): WindowIdentity | null;
  /** Returns immediate owned windows, including modal windows. Windows only. */
  getChildren?(): WindowIdentity[];
  /** Changes input availability. Active modal blockers reject changes. Windows only. */
  setEnabled?(enabled: boolean): void;
  /** Reads actual native input availability. Windows only. */
  isEnabled?(): boolean;
  /** Changes future activation eligibility without transferring current focus. Windows only. */
  setFocusable?(focusable: boolean): void;
  /** Reads whether the native window permits activation. Independent of isFocused. Windows only. */
  isFocusable?(): boolean;
  /** Read the creation-time caption mode, including during fullscreen. Windows only. */
  getTitlebar?(): "system" | "custom";
  /** Change topmost placement without activation. Native ownership can affect related window Z order. Windows only. */
  setAlwaysOnTop?(alwaysOnTop: boolean): void;
  /** Read live topmost style. Windows only. */
  isAlwaysOnTop?(): boolean;
  /** Move once to the top of the window's Z-order band without activation or focus change. A topmost window stays among topmost windows. Windows only. */
  moveTop?(): void;
  /** Move once below the other normal windows without activation. BUSY while alwaysOnTop is set, and Windows raises the window again when it is activated. Windows only. */
  moveToBottom?(): void;
  /** Change taskbar/Alt+Tab exclusion on a hidden, normal window. BUSY otherwise. Windows only. */
  setSkipTaskbar?(skipTaskbar: boolean): void;
  /** Read explicit tool-window exclusion; owned windows may also be absent from the taskbar. Windows only. */
  isSkipTaskbar?(): boolean;
  /** Change screenshot and screen-sharing exclusion. Windows 10 before 2004 shows black content instead of omitting the window; macOS 15 and later is best effort. Windows and macOS. */
  setContentProtection?(contentProtection: boolean): void;
  /** Read live exclusion from the OS, including the Windows black-content fallback. Windows and macOS. */
  isContentProtected?(): boolean;
  /** Flashes the taskbar button without focusing, showing or reordering the window. Repeated calls replace the previous mode. Windows only. */
  requestAttention?(mode: WindowAttentionMode): void;
  /** Stops taskbar flashing and restores the button. Succeeds when the window is not flashing. Windows only. */
  cancelAttention?(): void;
  /** Changes the native minimize button and user system commands. Programmatic minimize remains available. Windows only. */
  setMinimizable?(minimizable: boolean): void;
  /** Reads the normal window's native minimize-button setting. Windows only. */
  isMinimizable?(): boolean;
  /** Changes the native maximize button and user system commands. Programmatic maximize remains available. Windows only. */
  setMaximizable?(maximizable: boolean): void;
  /** Reads the normal window's native maximize-button setting. Windows only. */
  isMaximizable?(): boolean;
  /** Allows or rejects entering fullscreen for this HWND; an active fullscreen stays and can always be exited. Native caption buttons are unaffected. Windows only. */
  setFullscreenable?(fullscreenable: boolean): void;
  /** Reads whether entering fullscreen is allowed for this HWND. Windows only. */
  isFullscreenable?(): boolean;
  /** Sets whole-window opacity from 0 (transparent) to 1 (opaque) for this HWND, including its WebView. Windows only. */
  setOpacity?(opacity: number): void;
  /** Reads the live opacity from the OS, quantized to 8-bit alpha. Windows only. */
  getOpacity?(): number;
  /** Shows or hides the system shadow of a window with a custom title bar. A native title bar keeps its shadow, so hiding it is rejected. Windows only. */
  setHasShadow?(shadow: boolean): void;
  /** Reads whether this HWND has its system shadow. Windows only. */
  hasShadow?(): boolean;
  /** Requests rounded (true, the system default) or square (false) window corners for this HWND. Squaring is accepted only for a window with a custom title bar. The corners are a DWM hint that takes effect on Windows 11 and later. Windows only. */
  setRoundedCorners?(rounded: boolean): void;
  /** Reads the requested corner preference, true until squared. Windows only. */
  hasRoundedCorners?(): boolean;
  /** Requests the system backdrop material (`auto`, `none`, `mica`, `acrylic`, `tabbed`) behind this HWND's frame. A DWM hint that takes effect on Windows 11 22H2 and later; earlier builds skip the DWM call. Throws UNSUPPORTED for any value other than `auto` or `none` on a `transparent` window. Windows only. */
  setBackgroundMaterial?(
    material: "auto" | "none" | "mica" | "acrylic" | "tabbed",
  ): void;
  /** Reads the requested backdrop material, `auto` until set. Windows only. */
  getBackgroundMaterial?(): "auto" | "none" | "mica" | "acrylic" | "tabbed";
  /** Sets the opaque `#rrggbb` color of the window and its WebView for this HWND. Throws UNSUPPORTED on a `transparent` window. Windows only. */
  setBackgroundColor?(color: string): void;
  /** Reads the color set by the declaration, creation option or setBackgroundColor; null when none was set. Windows only. */
  getBackgroundColor?(): string | null;
  /** Lets mouse input pass through the whole window, including its WebView, to the window beneath. Windows only. */
  setIgnoreMouseEvents?(ignore: boolean): void;
  /** Reads whether this HWND currently ignores mouse input. Windows only. */
  isIgnoreMouseEvents?(): boolean;
  /** Changes user caption, system-menu and renderer closing. Backend/API closing remains available. Windows only. */
  setClosable?(closable: boolean): void;
  /** Reads the host's user-close setting for this HWND. Windows only. */
  isClosable?(): boolean;
  /** Changes this HWND's title without modifying its declaration or other instances. Windows only. */
  setTitle?(title: string): void;
  /** Reads the live native title, bounded to 1024 UTF-16 code units. Windows only. */
  getTitle?(): string;
  /** Sets the screen reader name separately from the caption; an empty string restores the caption. Windows only. */
  setAccessibleTitle?(title: string): void;
  /** Reads the last accessible title applied in this process, or null when none is set. Windows only. */
  getAccessibleTitle?(): string | null;
  /** Changes user border/system-menu resizing without restricting programmatic geometry. Windows only. */
  setResizable?(resizable: boolean): void;
  /** Reads the normal window's resize policy, including while fullscreen. Windows only. */
  isResizable?(): boolean;
  /** Changes user caption/system-menu movement without restricting programmatic positioning. Windows only. */
  setMovable?(movable: boolean): void;
  /** Reads the current user movement policy. Windows only. */
  isMovable?(): boolean;
  /** Locks user resizing to a content width / height ratio, or releases it with null. Does not resize the window now. Windows only. */
  setAspectRatio?(ratio: number | null): void;
  /** Reads the locked content width / height ratio, or null when none is set. Windows only. */
  getAspectRatio?(): number | null;
  /**
   * Hands the held primary mouse button to the system move loop. Throws INVALID_ARGUMENT unless the button
   * is down, for minimized, maximized or fullscreen windows, and when setMovable(false) applies. Windows only.
   */
  startDragging?(): void;
  /**
   * Hands the held primary mouse button to the system size loop from the given edge or corner. Throws
   * INVALID_ARGUMENT unless the button is down, for minimized, maximized or fullscreen windows, and when
   * the window is not resizable or its size limits pin every axis the direction changes. Windows only.
   */
  startResizeDragging?(direction: WindowResizeDirection): void;
  /**
   * Minimizes and displays the window, allowing Windows to activate another window.
   * On macOS the state operations below only change the miniaturized and zoomed state and
   * request no activation; maximize means zoom, not fullscreen.
   */
  minimize(): void;
  /** Maximizes and displays the window, requesting activation. */
  maximize(): void;
  /** Displays the normal size even when minimized from maximized, requesting activation. */
  unmaximize(): void;
  /** Displays the saved state when minimized, otherwise the normal size, requesting activation. */
  restore(): void;
  /** Switches the current native maximized state to normal or maximized, requesting activation. */
  toggleMaximize(): void;
  /** Reads the native minimized state. */
  isMinimized(): boolean;
  /** Reads the native maximized state, independently of fullscreen mode. */
  isMaximized(): boolean;
  /** Reports whether the host applied fullscreen mode to this native window. */
  isFullscreen(): boolean;
  /** Reads physical screen bounds, or the outer bounds used for normal restoration. */
  getBounds(area: "content" | "outer" | "normal"): WindowBounds;
  /** Reads the window's current DPI, including the latest processed DPI change. */
  getDpi(): number;
  /** Reads native visibility; minimized windows can still be visible. */
  isVisible(): boolean;
  /** Reports whether this window is the OS foreground window, including focus in its WebView. */
  isFocused(): boolean;
  /** Reads the current resize bounds. */
  getSizeConstraints(): WindowSizeConstraints;
  /** Applies resize bounds to the window. */
  setSizeConstraints(constraints: WindowSizeConstraints): void;
  /** Sets the requested content width and height in 96-DPI logical pixels. */
  setSize(width: number, height: number): void;
  /** Positions the outer top-left in physical pixels from the primary screen origin. */
  setPosition(x: number, y: number): void;
  /**
   * Centers outer/normal restoration bounds in a monitor work area, preserving state.
   * Without `monitorId`, uses the monitor nearest the normal bounds. With one, resolves
   * the public monitor ID against the monitors connected at call time; an unknown or
   * removed ID is INVALID_ARGUMENT and never falls back to the primary or current monitor.
   * Platforms without monitor IDs throw UNSUPPORTED when `monitorId` is given. Windows only.
   */
  center?(monitorId?: string): void;
  /**
   * Applies physical content or outer geometry without showing or activating the window.
   * While minimized/maximized, edits normal restoration bounds. Rejects fullscreen and
   * content sizes outside 200..8192 logical pixels before clamping to current limits.
   * Position and size pairs must be complete; native failures throw.
   */
  setGeometry(
    area: "content" | "outer",
    geometry:
      | {
          x: number;
          y: number;
        }
      | {
          width: number;
          height: number;
        }
      | Omit<WindowBounds, "dpi">,
  ): void;
  /** Enters or exits fullscreen mode. */
  setFullscreen(value: boolean): void;
  /** Set this window's taskbar progress; throws BUSY until its taskbar button exists. Windows only. */
  setTaskbarProgress?(
    progress:
      | {
          state: "none" | "indeterminate";
        }
      | {
          state: "normal" | "paused" | "error";
          value: number;
        },
  ): void;
  /**
   * Show only `region` of this window's client area in its taskbar thumbnail, or all of it for `null`.
   * Units are 96 DPI logical pixels; parts beyond the client area are clamped away, and a region
   * that is then empty throws INVALID_ARGUMENT. While minimized the client size is unknown, so the region is not clamped.
   * Throws BUSY until its taskbar button exists. Windows only.
   */
  setThumbnailClip?(
    region: {
      x: number;
      y: number;
      width: number;
      height: number;
    } | null,
  ): void;
  /** Set this window's taskbar thumbnail tooltip, or restore the default for `null` or an empty string. Throws BUSY like `setTaskbarProgress`. Windows only. */
  setThumbnailToolTip?(toolTip: string | null): void;
  /** Whether an icon set through `setIcon` is applied to this window. Windows only. */
  hasCustomIcon?(): boolean;
  /**
   * Set the icon shown in this window's title bar, Alt+Tab and taskbar button from `icon`, called once for the
   * small and once for the big size, or return to the application icon for `null`. The host owns the handles
   * `icon` returns (see `NativeOverlayIconProvider`) and a rejected image keeps the current icon. Windows only.
   */
  setIcon?(icon: NativeOverlayIconProvider | null): void;
  /**
   * Set this window's taskbar overlay icon from `icon` with an accessibility description, or remove the
   * overlay for `null`, which ignores `description`. The host owns the handles `icon` returns (see
   * `NativeOverlayIconProvider`). Errors thrown by `icon` propagate; BUSY like `setTaskbarProgress`.
   * Windows only.
   */
  setOverlayIcon?(
    icon: NativeOverlayIconProvider | null,
    description: string,
  ): void;
  /**
   * Replace this window's taskbar thumbnail toolbar with `buttons` in order (at most
   * `NATIVE_THUMBNAIL_BUTTON_LIMIT`); an empty list hides every button. The host owns the handles each
   * button's `icon` returns, keeps the buttons across Explorer restarts and reports a press as
   * `windows.thumbnailToolbarClicked` with the pressed button's `id`. Errors thrown by `icon` propagate
   * and keep the current toolbar; BUSY like `setTaskbarProgress`. Windows only.
   */
  setThumbnailToolbar?(buttons: readonly NativeThumbnailButton[]): void;
  /** Sets or clears the confirmation shown before a user closes the window. */
  setCloseConfirmation(message: string | null): void;
};

/** Maximum retained pending, active and terminal downloads per WebView. */
export const MAX_WEBVIEW_DOWNLOADS = 32;
/** Maximum UTF-8 JSON bytes for one download's combined URL, MIME, disposition and path. */
export const MAX_DOWNLOAD_METADATA_BYTES = 64 * 1024;
/** Snapshot budget including per-record scalar reserves; leaves half the 1 MiB wire limit for envelopes. */
export const MAX_DOWNLOAD_SNAPSHOT_BYTES = MAX_MESSAGE_BYTES / 2;
const DOWNLOAD_RECORD_RESERVED_BYTES = 512;
/** Approval deadline; an undecided download is cancelled without creating its output. */
export const DOWNLOAD_APPROVAL_TIMEOUT_MS = 30_000;

/** Download state owned by one native WebView lifetime, accessible only to the trusted backend. */
export type WebViewDownload = {
  id: string;
  url: string;
  mimeType: string;
  contentDisposition: string;
  /** WebView2-selected absolute destination; this API does not accept caller-selected paths. */
  path: string;
  totalBytes: number | null;
  receivedBytes: number | null;
  state: "pending" | "inProgress" | "interrupted" | "completed" | "cancelled";
  interruptReason: number | null;
  canResume: boolean;
  paused: boolean;
};

/** Bound metadata exactly as JSON encodes it, including escaped controls and non-ASCII text. */
export function isDownloadSnapshotWithinLimits(
  records: readonly WebViewDownload[],
): boolean {
  if (records.length > MAX_WEBVIEW_DOWNLOADS) {
    return false;
  }
  const encoder = new TextEncoder();
  let bytes = 2; // Array delimiters; retained terminal records consume the same budget.
  for (const record of records) {
    const metadata = encoder.encode(
      JSON.stringify({
        url: record.url,
        mimeType: record.mimeType,
        contentDisposition: record.contentDisposition,
        path: record.path,
      }),
    ).byteLength;
    if (metadata > MAX_DOWNLOAD_METADATA_BYTES) {
      return false;
    }
    // UUID, property names, booleans, longest state and safe-integer counters fit in 512 bytes.
    // Reserve their worst case before approval so progress/expiry never exhaust the budget.
    bytes += metadata + DOWNLOAD_RECORD_RESERVED_BYTES;
    if (bytes > MAX_DOWNLOAD_SNAPSHOT_BYTES) {
      return false;
    }
  }
  return true;
}

/** Every method requires backend origin and its own operation grant before native entry. */
export type NativeDownloads = {
  /** Opt into collecting requests, without approving them. Disabling cancels pending requests. */
  setRequestsEnabled(enabled: boolean): void;
  /** Return bounded detached snapshots, including pending approvals and terminal records. */
  list(): WebViewDownload[];
  /** Approve exactly one pending item using the browser-selected destination and default browser UI. */
  approve(id: string): void;
  /** Reject a pending item or cancel an active item; repeat cancellation is safe. */
  cancel(id: string): void;
  /** Pause only an active item; actual resumability is reported by list. */
  pause(id: string): void;
  /** Resume only when WebView2 reports that the item is resumable. */
  resume(id: string): void;
  /** Release a terminal record; forgetting an active or pending item is rejected. */
  forget(id: string): void;
};

/**
 * Synchronous UI-thread controls; navigation retains the host's origin and session boundary.
 *
 * Each window owns exactly one WebView with the same lifetime, so a destroyed WebView is a
 * closed window (`isDestroyed`) and state reads on it fail with INVALID_ARGUMENT.
 */
export type NativeWebView = {
  /**
   * Reads browser state without changing focus or starting navigation.
   *
   * `focused` is true only when the window is the OS foreground window and keyboard input focus
   * is inside its WebView, so it implies the window is focused but not the reverse.
   */
  getState(): {
    url: string;
    title: string;
    loading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
    zoomFactor: number;
    focused: boolean;
  };
  /** Starts HTTP(S) navigation only to an origin already allowed for this view. */
  navigate(url: string): void;
  /**
   * Reloads the current document. With `ignoreCache`, Windows reloads without reading the
   * WebView2 cache and macOS uses `reloadFromOrigin`, an end-to-end reload whose request
   * headers are not verified here; otherwise the normal reload revalidates cached entries.
   */
  reload(ignoreCache?: boolean): void;
  /** Requests cancellation of pending navigation and resource loads. */
  stop(): void;
  /** Starts history navigation; false means that direction has no entry. */
  goBack(): boolean;
  goForward(): boolean;
  /** Sets the controller zoom, returning the actual browser value. */
  setZoomFactor(factor: number): number;
  /** Opens the browser's DevTools window only when the host enabled development tools. */
  openDevTools(): void;
};

/** Independent display facts, using the same meaning as the window query APIs. */
export type WindowDisplayState = {
  visible: boolean;
  focused: boolean;
  minimized: boolean;
  maximized: boolean;
  fullscreen: boolean;
  /** Same meaning as the `isAlwaysOnTop` query. */
  alwaysOnTop: boolean;
};
/** Browser playback and mute are independent; playing can remain true while muted. */
export type WebViewAudioState = {
  muted: boolean;
  playing: boolean;
};
/** Window-owned WebView audio settings; navigation preserves mute and recreation resets it. */
export type NativeWebViewAudio = {
  getState(): WebViewAudioState;
  setMuted(muted: boolean): void;
};
/** Identifies one native window lifetime separately from its policy view. */
export type WindowIdentity = {
  /** Opaque native lifetime ID; navigation preserves it and recreation replaces it. */
  windowId: string;
  viewId: string;
};
/** One committed observation; revision increases within a unique native window lifetime. */
export type WindowSnapshot = {
  windowId: WindowIdentity["windowId"];
  viewId: WindowIdentity["viewId"];
  revision: number;
  state: WindowDisplayState;
  bounds: WindowBounds;
};
/** Changes emitted in snapshot-comparison order, followed by native move/resize completion. */
export type WindowChange =
  | "shown"
  | "hidden"
  | "focus"
  | "blur"
  | "unmaximize"
  | "minimize"
  | "maximize"
  | "restore"
  | "enterFullscreen"
  | "leaveFullscreen"
  | "enterAlwaysOnTop"
  | "leaveAlwaysOnTop"
  | "move"
  | "resize"
  | "moved"
  | "resized";
/** OS invalidations and ordered lifecycle signals. No borrowed native pointers leave the callback. */
export type NativeSystemSignal =
  | "settingChanged"
  | "themeChanged"
  | "colorsChanged"
  | "accentChanged"
  | "powerStatusChanged"
  | "suspend"
  | "resume"
  | "sessionLocked"
  | "sessionUnlocked";

/** UI-thread OS notifications shared by optional native plugins. */
export type NativeSystemEvents = {
  /** Lazily acquire a hidden top-level window. Callbacks run after the pump. State invalidations coalesce; lifecycle edges preserve order. Session notifications are opt-in and registration failure throws. Dispose removes the subscription. */
  subscribe(
    receive: (signal: NativeSystemSignal) => void,
    options?: {
      sessionNotifications?: boolean;
    },
  ): () => void;
  /** Send to live subscribers with both event policy and the named read-operation grant. Uses the existing bounded native event lane. */
  publish(
    event: string,
    payload: import("@bunaway/protocol").JsonValue,
    requiredOperation: string,
  ): void;
};

export type {
  NativeAppearanceWindow,
  NativeAppearanceWindows,
  NativeContentColorScheme,
} from "./native-appearance.ts";

/** UI-thread services used by installed native plugins. */
export type NativeWindowServices = {
  /** Opt-in frame appearance controls, scoped to each native lifetime. */
  appearance?: import("./native-appearance.ts").NativeAppearanceWindows;
  /** Live display queries. Absent on platforms without monitor support. */
  monitors?: NativeMonitorServices;
  /** Optional OS change notifications. Absent on hosts without a native notification window. */
  systemEvents?: NativeSystemEvents;
  /** Whether this UI adapter supports per-creation presentation options; absent means unsupported. */
  supportsCreationOptions?: boolean;
  /** Validate display-dependent placement without acquiring resources, before reservation and close. */
  validateCreation?(spec: WindowSpec): void;
  /** Configured windows available to the plugin. */
  specs: readonly WindowSpec[];
  /**
   * Observe each lifecycle phase the host publishes, in publication order and never after shutdown
   * starts. Returns a function that removes the listener. Absent when the host publishes none.
   */
  onLifecycle?(listener: (event: WindowLifecycleEvent) => void): () => void;
  /**
   * Observe each change of a WebView's mute setting or playback state, in order and never after
   * shutdown starts. Returns a function that removes the listener. Absent when the host reports none.
   */
  onAudioChange?(listener: (event: WindowAudioChangeEvent) => void): () => void;
  /**
   * Observe each WebView process failure the host handles, in order and never after shutdown starts.
   * Returns a function that removes the listener. Absent when the host reports none.
   */
  onProcessFailure?(
    listener: (event: WindowProcessFailureEvent) => void,
  ): () => void;
  /** Read-only native identity discovery. Missing on platforms without identity tracking. */
  lookup?: {
    /** Unknown or destroyed native lifetimes return null. */
    byId(windowId: string): WindowIdentity | null;
    /** An uncreated or closed policy view returns null. */
    byView(viewId: string): WindowIdentity | null;
    /** Resolve the authenticated pending host request to its exact originating native window. */
    byRequest?(requestId: string): WindowIdentity | null;
    /** The OS foreground window, or null when it belongs to another host. */
    focused(): WindowIdentity | null;
    /** Cleared on destruction, with no fallback to earlier activated windows. */
    lastActive(): WindowIdentity | null;
  };
  /** Reads a window's lifecycle state, or returns `undefined` for an unknown logical instance key. */
  read(view: string): WindowState | undefined;
  /** Creates from validated configuration; a live replacement preserves its captured owner lifetime. */
  create(
    spec: WindowSpec,
    replacingLiveWindow?: boolean,
    instanceKey?: string,
  ): void;
  /** Releases native replacement metadata after creation succeeds, fails or is cancelled. */
  creationSettled?(instanceKey: string): void;
  /** Closes before replacement by default. Pass false for a final splash handoff without preserving instance resources. Reports close acceptance. */
  close(view: string, replacing?: boolean): boolean | Promise<boolean>;
  /** Unconditionally retires an incomplete creation on cancellation or failure. Windows only. */
  destroy?(view: string): boolean | Promise<boolean>;
  /** Gets native controls for a logical instance key. */
  window(view: string): NativeWindow;
  /** Reports whether app shutdown has started. */
  stopping(): boolean;
  /** Reports whether a pending host request was cancelled. */
  cancelled(requestId: string): boolean;
  /** Returns the current timestamp in milliseconds. */
  now(): number;
  /** Yields to the UI loop while asynchronous window work is pending. */
  tick(): Promise<void>;
};

/** Host-only services for a modal picker on the existing UI STA. Never exposed to web callers. */
export type NativeDialogServices = {
  /** Record control-packet cancellation while normal dispatch is deferred by a native modal loop. */
  watchCancellation(requestId?: string): {
    cancelled(): boolean;
    dispose(): void;
  };
  /** Create an invisible host-class window on this STA; the picker must destroy it after Show returns. */
  createWindow(receive: (message: number) => void): bigint;
  destroyWindow(hwnd: bigint): void;
  /** Resolve the authenticated originating window, never a caller-supplied view ID. */
  origin(requestId: string): WindowIdentity | null;
  /** Capture the app's window as the dialog owner, or null when it is not open and shown. It never retargets a recreated window. */
  owner(): {
    hwnd: bigint;
    alive(): boolean;
  } | null;
  /** Drain synchronous host control packets during the native modal loop. Must not pump COM or Promise jobs. */
  poll(): void;
  /** A committed app shutdown cancels even an unowned picker. */
  stopping(): boolean;
};
