/** Inclusive accepted dimension range for window sizes. */
export const MIN_WINDOW_DIMENSION = 200;
export const MAX_WINDOW_DIMENSION = 4096;

/** Win32 screen geometry uses signed 32-bit components. */
export const MIN_WINDOW_COORDINATE = -2147483648;
export const MAX_WINDOW_COORDINATE = 2147483647;

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

/** Optional inclusive lower and upper bounds for a window's width and height. */
export type WindowSizeConstraints = {
  minWidth: number | null;
  minHeight: number | null;
  maxWidth: number | null;
  maxHeight: number | null;
};

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

/** Maximum number of window definitions accepted at startup, independent of instance capacity. */
export const MAX_WINDOWS = 128;

/** Maximum active, reserved and cleaning native window instances per app. */
export const MAX_WINDOW_INSTANCES = 128;

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
  };
  /** Single by default. Multiple allows explicit ID-addressed instances on Windows. */
  instances?: "single" | "multiple";
  /** Required for multiple: an integer from 1 through MAX_WINDOW_INSTANCES. */
  maxInstances?: number;
  /** Shared persistent per-view storage by default; isolated is temporary per logical instance. */
  profile?: "shared" | "isolated";
  /** Whether the runtime creates one instance of this definition during startup. */
  startup?: boolean;
  /** Initial visibility, default true. Hidden creation never activates the window. Windows only. */
  visible?: boolean;
  /** Create hidden and show once after the document, or document and SDK, are ready. Windows only. */
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

/**
 * Native controls exposed to an installed window plugin.
 * The plugin rejects minimized/maximized transitions during fullscreen before invoking these controls.
 * Native failures throw; the UI host converts them to bounded public errors.
 */
export type NativeWindow = {
  /** Reads a versioned state and physical outer-bounds snapshot for recovery after subscribing. */
  getSnapshot(): WindowSnapshot;
  /** Reads the latest preparation outcome, including a retained closed-window outcome. Windows only. */
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
  /** Changes the native minimize button and user system commands. Programmatic minimize remains available. Windows only. */
  setMinimizable?(minimizable: boolean): void;
  /** Reads the normal window's native minimize-button setting. Windows only. */
  isMinimizable?(): boolean;
  /** Changes the native maximize button and user system commands. Programmatic maximize remains available. Windows only. */
  setMaximizable?(maximizable: boolean): void;
  /** Reads the normal window's native maximize-button setting. Windows only. */
  isMaximizable?(): boolean;
  /** Changes user caption, system-menu and renderer closing. Backend/API closing remains available. Windows only. */
  setClosable?(closable: boolean): void;
  /** Reads the host's user-close setting for this HWND. Windows only. */
  isClosable?(): boolean;
  /** Minimizes and displays the window, allowing Windows to activate another window. */
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
  /** Centers outer/normal restoration bounds in the current monitor work area, preserving state. Windows only. */
  center?(): void;
  /**
   * Applies physical content or outer geometry without showing or activating the window.
   * While minimized/maximized, edits normal restoration bounds. Rejects fullscreen and
   * content sizes outside 200..4096 logical pixels before clamping to current limits.
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
  /** Sets or clears the confirmation shown before a user closes the window. */
  setCloseConfirmation(message: string | null): void;
};

/** Independent display facts, using the same meaning as the window query APIs. */
export type WindowDisplayState = {
  visible: boolean;
  focused: boolean;
  minimized: boolean;
  maximized: boolean;
  fullscreen: boolean;
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
/** Changes emitted in the order of a committed snapshot comparison. */
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
  | "move"
  | "resize";
/** UI-thread services used by the native windows plugin. */
export type NativeWindowServices = {
  /** Whether this UI adapter supports per-creation presentation options; absent means unsupported. */
  supportsCreationOptions?: boolean;
  /** Validate display-dependent placement without acquiring resources, before reservation and close. */
  validateCreation?(spec: WindowSpec): void;
  /** Configured windows available to the plugin. */
  specs: readonly WindowSpec[];
  /** All native lifetimes, including resources still being cleaned. Keys are host-private logical owners. */
  instances?(): readonly {
    key: string;
    identity: WindowIdentity;
  }[];
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
