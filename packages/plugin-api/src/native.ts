/** Inclusive accepted dimension range for window sizes. */
export const MIN_WINDOW_DIMENSION = 200;
export const MAX_WINDOW_DIMENSION = 4096;

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

/** Validated configuration for one app window and its WebView. */
export type WindowSpec = {
  /** Unique policy view served by this window. */
  view: string;
  /** Initial URL, restricted by the view's allowed origin. */
  home: string;
  /** Native window title. */
  title: string;
  /** Initial logical dimensions and optional resize limits. */
  window: {
    width: number;
    height: number;
    minWidth?: number | null;
    minHeight?: number | null;
    maxWidth?: number | null;
    maxHeight?: number | null;
  };
  /** Whether the runtime creates this window during startup. */
  startup?: boolean;
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
  /** Shows or hides the native window. */
  show(visible: boolean): void;
  /** Focuses the window and reports whether the request succeeded. */
  focus(): boolean;
  /** Starts a normal close request; returns false when it is declined or hides to tray. */
  close(): boolean | Promise<boolean>;
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
/** One committed observation; revision increases within a unique native window lifetime. */
export type WindowSnapshot = {
  windowId: string;
  viewId: string;
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
  /** Configured windows available to the plugin. */
  specs: readonly WindowSpec[];
  /** Reads a window's lifecycle state, or returns `undefined` for an unknown view. */
  read(view: string): WindowState | undefined;
  /** Creates a window from its validated configuration. */
  create(spec: WindowSpec): void;
  /** Closes a window before replacement and reports whether closing was accepted. */
  close(view: string): boolean | Promise<boolean>;
  /** Gets native controls for an existing view. */
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
