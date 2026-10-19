import { dlopen, JSCallback, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import assert from "node:assert/strict";
import { checkHresult, wide, withWide } from "@bunaway/plugin/win32";
import {
  clampWindowSize,
  hasValidWindowPlacement,
  hasValidWindowSizeConstraints,
  isWindowAspectRatio,
  MAX_WINDOW_DIMENSION,
  MIN_WINDOW_DIMENSION,
  type NativeOverlayIconProvider,
  type NativeWindow,
  type WindowAttentionMode,
  type WindowBounds,
  type WindowChange,
  type WindowIdentity,
  type WindowPlacement,
  type WindowSizeConstraints,
  type WindowSnapshot,
  type WindowSpec,
} from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";
import {
  APP_SHUTDOWN_MESSAGE,
  APP_WINDOW_CLASS_PREFIX,
} from "@bunaway/runtime-bun/windows-control";
import { AccessibleTitles } from "./accessible-title.ts";
import { adjustSizingRect, systemTrackSize } from "./aspect-ratio.ts";
import { monitorServices } from "./monitors.ts";
import type { SessionMessageHandler } from "./session-end.ts";
import type { TaskbarProgress, ThumbnailClip } from "./taskbar-progress.ts";
import { display, kernel, user } from "./win32-bindings.ts";
import {
  COLOR_WINDOW,
  CW_USEDEFAULT,
  DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
  FLASHW_STOP,
  FLASHW_TIMER,
  FLASHW_TIMERNOFG,
  FLASHW_TRAY,
  FLASHWINFO_SIZE,
  GW_OWNER,
  GWL_EXSTYLE,
  GWL_STYLE,
  GWLP_HWNDPARENT,
  IDI_APPLICATION,
  IDYES,
  IMAGE_ICON,
  LR_LOADFROMFILE,
  LWA_ALPHA,
  MA_NOACTIVATE,
  MAX_ALPHA,
  MB_DEFBUTTON2,
  MB_ICONQUESTION,
  MB_YESNO,
  MENU_ITEM_ERROR,
  MF_ENABLED,
  MF_GRAYED,
  MINMAXINFO_SIZE,
  MONITOR_DEFAULTTONEAREST,
  MONITOR_DEFAULTTOPRIMARY,
  MONITORINFO_SIZE,
  PM_REMOVE,
  RECT_SIZE,
  SC_CLOSE,
  SC_MAXIMIZE,
  SC_MINIMIZE,
  SC_MOVE,
  SC_RESTORE,
  SC_SIZE,
  SM_CXMAXTRACK,
  SM_CXMINTRACK,
  SM_CXPADDEDBORDER,
  SM_CXSIZEFRAME,
  SM_CYMAXTRACK,
  SM_CYMINTRACK,
  SM_CYSIZEFRAME,
  SW_HIDE,
  SW_MINIMIZE,
  SW_RESTORE,
  SW_SHOW,
  SW_SHOWMAXIMIZED,
  SW_SHOWMINIMIZED,
  SW_SHOWMINNOACTIVE,
  SW_SHOWNA,
  SW_SHOWNOACTIVATE,
  SW_SHOWNORMAL,
  SWP_FRAMECHANGED,
  SWP_NOACTIVATE,
  SWP_NOMOVE,
  SWP_NOSIZE,
  SWP_NOZORDER,
  SYSTEM_COMMAND_MASK,
  WA_INACTIVE,
  WDA_EXCLUDEFROMCAPTURE,
  WDA_MONITOR,
  WDA_NONE,
  WINDOWPLACEMENT_FLAGS_OFFSET,
  WINDOWPLACEMENT_NORMAL_RECT_OFFSET,
  WINDOWPLACEMENT_SHOW_CMD_OFFSET,
  WINDOWPLACEMENT_SIZE,
  WINDOWPOS_SIZE,
  WM_ACTIVATE,
  WM_CLOSE,
  WM_DISPLAYCHANGE,
  WM_DPICHANGED,
  WM_ENTERSIZEMOVE,
  WM_EXITSIZEMOVE,
  WM_GETMINMAXINFO,
  WM_MOUSEACTIVATE,
  WM_OBSERVE_WINDOW,
  WM_QUIT,
  WM_SIZING,
  WM_SYSCOMMAND,
  WM_WINDOWPOSCHANGED,
  WM_WINDOWPOSCHANGING,
  WPF_RESTORETOMAXIMIZED,
  WS_MAXIMIZE,
  WS_MAXIMIZEBOX,
  WS_MINIMIZE,
  WS_MINIMIZEBOX,
  WS_THICKFRAME,
} from "./win32-constants.ts";
import { completedGeometryChanges, windowChanges } from "./window-events.ts";
import {
  centerInWorkArea,
  initialWindowPlacement,
  selectMonitorWorkArea,
  type WorkArea,
} from "./window-placement.ts";
import {
  constrainedOuterSize,
  DEFAULT_DPI,
  logicalPixels,
  physicalPixels,
} from "./window-size.ts";

import {
  initialWindowStyles,
  WS_CAPTION,
  WS_EX_LAYERED,
  WS_EX_NOACTIVATE,
  WS_EX_TOOLWINDOW,
  WS_EX_TOPMOST,
  WS_EX_TRANSPARENT,
  WS_OVERLAPPEDWINDOW,
} from "./window-style.ts";
import { WindowTaskbar } from "./window-taskbar.ts";

/** Host policy for the message pump, placement retries and title storage. */
const MAX_MESSAGES_PER_PUMP = 64;
const MAX_INITIAL_PLACEMENT_ATTEMPTS = 8;
const MAX_WINDOW_TITLE_LENGTH = 1024;

type SizeConstraints = Partial<WindowSizeConstraints>;
type ClientSize = {
  width: number;
  height: number;
};

function resolvedConstraints(
  constraints: SizeConstraints = {},
): WindowSizeConstraints {
  const resolved = {
    minWidth: constraints.minWidth ?? null,
    minHeight: constraints.minHeight ?? null,
    maxWidth: constraints.maxWidth ?? null,
    maxHeight: constraints.maxHeight ?? null,
  };
  assert(
    hasValidWindowSizeConstraints(resolved),
    "Invalid window size constraints.",
  );
  return resolved;
}

function callbackPointer(address: bigint): Pointer {
  // Win64 user-mode addresses fit JavaScript's exact integer range.
  assert(address > 0n && address <= BigInt(Number.MAX_SAFE_INTEGER));
  return Number(address) as Pointer;
}

type GeometryRequest = Parameters<NativeWindow["setGeometry"]>[1];
type Rectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function invalidGeometry(message: string): never {
  throw new BunawayError({
    code: "INVALID_ARGUMENT",
    message,
  });
}

/** All RECT edges and SetWindowPos components must fit signed Win32 LONGs. */
function assertRectangleFits({ x, y, width, height }: Rectangle) {
  for (const value of [
    x,
    y,
    width,
    height,
    x + width,
    y + height,
  ]) {
    if (!Number.isInteger(value) || (value | 0) !== value) {
      invalidGeometry("Window geometry exceeds the supported integer range.");
    }
  }
}

// One class and one bounded pump per STA, shared by every view.
export class Windows {
  private readonly taskbar = new WindowTaskbar({
    dpi: (window) => this.getDpi(window),
    isMinimized: (window) => this.isMinimized(window),
    clientSize: (window) => this.clientSize(window),
  });
  private readonly accessibleTitles = new AccessibleTitles();
  readonly thread = kernel.symbols.GetCurrentThreadId();
  private readonly instance = kernel.symbols.GetModuleHandleW(null);
  private readonly name = wide(
    `${APP_WINDOW_CLASS_PREFIX}${process.pid}-${this.thread}`,
  );
  private readonly message = Buffer.alloc(48); // MSG, Win64
  private readonly windows = new Map<
    bigint,
    (message: number, wparam: bigint, lparam: bigint) => void
  >();
  private readonly constraints = new Map<bigint, WindowSizeConstraints>();
  private readonly observations = new Map<
    bigint,
    {
      snapshot: WindowSnapshot;
      receive(snapshot: WindowSnapshot, changes: WindowChange[]): void;
    }
  >();
  private readonly changingGeometry = new Set<bigint>();
  private readonly closeControls = new Map<bigint, boolean>();
  /** Windows that may not enter fullscreen; absence means fullscreenable. */
  private readonly nonFullscreenable = new Set<bigint>();
  private readonly interactiveGeometry = new Map<bigint, WindowBounds>();
  private readonly immovable = new Set<bigint>();
  /** Content width / height locked for user resizing; absent when unlocked. */
  private readonly aspectRatios = new Map<bigint, number>();
  private readonly initialOuterSizes = new Map<
    bigint,
    {
      width: number;
      height: number;
    }
  >();
  private lastActiveWindow: bigint | null = null;
  private readonly dpiByWindow = new Map<bigint, number>();
  private readonly normalMonitors = new Map<
    bigint,
    {
      display: bigint;
      screenRect: Buffer;
    }
  >();
  private creatingConstraints: WindowSizeConstraints | undefined;
  private readonly callback: JSCallback;
  private readonly previousDpiAwarenessContext: bigint;
  private readonly fullscreen = new Map<
    bigint,
    {
      style: bigint;
      placement: Buffer;
      dpi: number;
      restoreSize: ClientSize;
      visible: boolean;
      /** Initial fullscreen has no prior display lifetime; exit retains current visibility. */
      initial?: boolean;
    }
  >();
  private registered = false;
  failure: unknown;
  readonly icon: bigint;
  private readonly smallIcon: bigint;
  private readonly ownedIcons: boolean;

  /**
   * Register the window class and set this STA to per-monitor-v2 awareness.
   * `sessionMessage` answers WM_QUERYENDSESSION and WM_ENDSESSION for every window of the class.
   */
  constructor(
    shutdown: () => void,
    iconPath?: string,
    appId?: string,
    pollMessages?: () => void,
    private readonly sessionMessage?: SessionMessageHandler,
  ) {
    if (appId) {
      const shell = dlopen("shell32.dll", {
        SetCurrentProcessExplicitAppUserModelID: {
          args: [
            "ptr",
          ],
          returns: "i32",
        },
      });
      try {
        checkHresult(
          withWide(appId, (id) =>
            shell.symbols.SetCurrentProcessExplicitAppUserModelID(id),
          ),
          "AppUserModelID",
        );
      } finally {
        shell.close();
      }
    }
    this.ownedIcons = !!iconPath;
    if (iconPath?.toLowerCase().endsWith(".exe")) {
      const shell = dlopen("shell32.dll", {
        ExtractIconExW: {
          args: [
            "ptr",
            "i32",
            "ptr",
            "ptr",
            "u32",
          ],
          returns: "u32",
        },
      });
      const large = new BigUint64Array(1);
      const small = new BigUint64Array(1);
      try {
        withWide(iconPath, (path) =>
          shell.symbols.ExtractIconExW(path, 0, ptr(large), ptr(small), 1),
        );
        this.icon = large[0] ?? 0n;
        this.smallIcon = small[0] ?? 0n;
      } finally {
        shell.close();
      }
    } else {
      this.icon = iconPath
        ? withWide(iconPath, (path) =>
            user.symbols.LoadImageW(
              0n,
              path,
              IMAGE_ICON,
              32,
              32,
              LR_LOADFROMFILE,
            ),
          )
        : user.symbols.LoadIconW(0n, IDI_APPLICATION);
      this.smallIcon = iconPath
        ? withWide(iconPath, (path) =>
            user.symbols.LoadImageW(
              0n,
              path,
              IMAGE_ICON,
              16,
              16,
              LR_LOADFROMFILE,
            ),
          )
        : this.icon;
    }
    if (!this.icon || !this.smallIcon) {
      this.releaseIcons();
      throw new Error("App icon could not be loaded.");
    }
    const previousDpiAwarenessContext =
      user.symbols.SetThreadDpiAwarenessContext(
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
      );
    if (!previousDpiAwarenessContext) {
      this.releaseIcons();
      throw new Error(
        `SetThreadDpiAwarenessContext: ${kernel.symbols.GetLastError()}`,
      );
    }
    this.previousDpiAwarenessContext = previousDpiAwarenessContext;
    this.callback = new JSCallback(
      (window: bigint, message: number, wparam: bigint, lparam: bigint) => {
        try {
          assert.equal(kernel.symbols.GetCurrentThreadId(), this.thread);
          // DispatchMessage can remain in a native move/resize loop until the user releases the mouse.
          pollMessages?.();
          // Session messages reach every top-level HWND of this thread (app, control, tray and
          // notification windows share this procedure); one handler answers for all of them.
          const sessionResult = this.sessionMessage?.(message, wparam, lparam);
          if (sessionResult !== undefined) {
            return sessionResult;
          }
          if (
            message === this.taskbar.buttonCreatedMessage &&
            this.windows.has(window)
          ) {
            this.taskbar.restore(window);
            return 0n;
          }
          if (message === APP_SHUTDOWN_MESSAGE) {
            shutdown();
            return 0n;
          }
          if (message === WM_OBSERVE_WINDOW) {
            this.observeChanges(window);
            return 0n;
          }
          if (message === WM_GETMINMAXINFO) {
            user.symbols.DefWindowProcW(window, message, wparam, lparam);
            this.applyMinMaxInfo(window, lparam);
            this.windows.get(window)?.(message, wparam, lparam);
            return 0n;
          }
          if (
            message === WM_SIZING &&
            this.applySizingAspectRatio(window, wparam, lparam)
          ) {
            return 1n; // TRUE: the rectangle was modified.
          }
          if (message === WM_DPICHANGED) {
            this.applyDpiChange(window, wparam, lparam);
            this.windows.get(window)?.(message, wparam, lparam);
            this.observeChanges(window);
            return 0n;
          }
          if (message === WM_WINDOWPOSCHANGING) {
            this.constrainMaximizedSize(window, lparam);
          }
          if (this.windows.has(window)) {
            if (message === WM_CLOSE && !this.isClosable(window)) {
              return 0n;
            }
            if (message === WM_SYSCOMMAND) {
              const command = wparam & SYSTEM_COMMAND_MASK;
              // CSS caption regions remain in the document during fullscreen. Do not let
              // their native gestures desynchronize the HWND from the saved fullscreen state.
              if (
                this.isFullscreen(window) &&
                this.getTitlebar(window) === "custom" &&
                (command === SC_MOVE ||
                  command === SC_SIZE ||
                  command === SC_MINIMIZE ||
                  command === SC_MAXIMIZE ||
                  command === SC_RESTORE)
              ) {
                return 0n;
              }
              if (
                (command === SC_MINIMIZE && !this.isMinimizable(window)) ||
                (command === SC_MAXIMIZE && !this.isMaximizable(window)) ||
                (command === BigInt(SC_CLOSE) && !this.isClosable(window))
              ) {
                return 0n;
              }
            }
          }
          if (
            message === WM_MOUSEACTIVATE &&
            this.windows.has(window) &&
            !this.isFocusable(window)
          ) {
            return MA_NOACTIVATE;
          }
          if (
            message === WM_SYSCOMMAND &&
            this.windows.has(window) &&
            !this.isFocusable(window)
          ) {
            const command = wparam & SYSTEM_COMMAND_MASK;
            if (
              command === SC_MINIMIZE ||
              command === SC_MAXIMIZE ||
              command === SC_RESTORE
            ) {
              // Default caption commands use activating ShowWindow modes even with NOACTIVATE.
              // Keep native button restrictions and leave fullscreen state changes to its API.
              if (!this.isFullscreen(window)) {
                const { style } = this.windowStyles(window);
                if (command === SC_MINIMIZE && style & WS_MINIMIZEBOX) {
                  this.minimize(window);
                }
                if (command === SC_MAXIMIZE && style & WS_MAXIMIZEBOX) {
                  this.maximize(window);
                }
                if (command === SC_RESTORE) {
                  this.restore(window);
                }
              }
              return 0n;
            }
          }
          if (
            message === WM_ENTERSIZEMOVE &&
            this.observations.has(window) &&
            !this.interactiveGeometry.has(window)
          ) {
            this.interactiveGeometry.set(
              window,
              this.getBounds(window, "outer"),
            );
          }

          if (message === WM_SYSCOMMAND && this.windows.has(window)) {
            // Caption dragging and keyboard/system-menu commands converge here.
            const command = wparam & SYSTEM_COMMAND_MASK;
            if (
              (command === SC_MOVE && !this.isMovable(window)) ||
              (command === SC_SIZE && !this.isResizable(window))
            ) {
              return 0n;
            }
          }
          this.windows.get(window)?.(message, wparam, lparam);
          if (message === WM_CLOSE) {
            return 0n; // defer Close/DestroyWindow past callback
          }
          const result = user.symbols.DefWindowProcW(
            window,
            message,
            wparam,
            lparam,
          );
          if (message === WM_EXITSIZEMOVE) {
            const start = this.interactiveGeometry.get(window);
            this.interactiveGeometry.delete(window);
            if (start) {
              this.observeChanges(window, start);
            }
          }
          if (message === WM_WINDOWPOSCHANGED && this.windows.has(window)) {
            this.rememberNormalMonitor(window);
          }
          if (message === WM_WINDOWPOSCHANGED) {
            // Z-order and topmost changes from any process arrive here.
            this.observeChanges(window);
          }
          if (message === WM_ACTIVATE && this.windows.has(window)) {
            // Record activation itself, including switches while WebView setup is pending.
            // Blur and read-only queries never change activation history.
            if ((wparam & 0xffffn) !== WA_INACTIVE) {
              this.lastActiveWindow = window;
            }
          }
          if (message === WM_ACTIVATE && this.observations.has(window)) {
            // Foreground identity can change after this synchronous activation callback returns.
            assert(
              user.symbols.PostMessageW(window, WM_OBSERVE_WINDOW, 0n, 0n),
            );
          }
          if (
            message === WM_DISPLAYCHANGE &&
            this.windows.has(window) &&
            !this.fullscreen.has(window)
          ) {
            // Refresh even without a query while the previous monitor is disconnected.
            this.readNormalMonitorInfo(
              window,
              this.getPlacement(window).subarray(
                WINDOWPLACEMENT_NORMAL_RECT_OFFSET,
              ),
            );
          }
          return result;
        } catch (error) {
          this.failure ??= error;
          return 0n;
        }
      },
      {
        args: [
          "u64",
          "u32",
          "u64",
          "i64",
        ],
        returns: "i64",
      },
    );
    const wc = Buffer.alloc(80); // WNDCLASSEXW, Win64
    wc.writeUInt32LE(80, 0);
    wc.writeBigUInt64LE(BigInt(this.callback.ptr ?? 0), 8);
    wc.writeBigUInt64LE(this.instance, 24);
    wc.writeBigUInt64LE(this.icon, 32);
    wc.writeBigUInt64LE(BigInt(COLOR_WINDOW + 1), 48);
    wc.writeBigUInt64LE(BigInt(ptr(this.name)), 64);
    wc.writeBigUInt64LE(this.smallIcon, 72);
    if (!user.symbols.RegisterClassExW(ptr(wc))) {
      this.callback.close();
      this.releaseIcons();
      user.symbols.SetThreadDpiAwarenessContext(
        this.previousDpiAwarenessContext,
      );
      throw new Error(`RegisterClassExW: ${kernel.symbols.GetLastError()}`);
    }
    this.registered = true;
  }

  /** Query physical work-area bounds for a native monitor; shared with later runtime placement. */
  getWorkArea(monitor: bigint): WorkArea {
    const info = Buffer.alloc(MONITORINFO_SIZE);
    info.writeUInt32LE(MONITORINFO_SIZE);
    assert(
      monitor && user.symbols.GetMonitorInfoW(monitor, ptr(info)),
      "Window monitor is unavailable.",
    );
    return {
      x: info.readInt32LE(20),
      y: info.readInt32LE(24),
      width: info.readInt32LE(28) - info.readInt32LE(20),
      height: info.readInt32LE(32) - info.readInt32LE(24),
    };
  }

  /** Validate display-dependent input before slot reservation, profile acquisition or replacement close. */
  validateCreation(options: WindowSpec["window"]) {
    this.initialPlacement(options);
  }

  /** Explicit physical point selects the nearest monitor; otherwise use the current HWND or primary. */
  getPlacementMonitor(
    position?: {
      x: number;
      y: number;
    },
    window?: bigint,
  ) {
    if (!position) {
      return user.symbols.MonitorFromWindow(
        window ?? 0n,
        window ? MONITOR_DEFAULTTONEAREST : MONITOR_DEFAULTTOPRIMARY,
      );
    }
    const point = Buffer.alloc(8);
    point.writeInt32LE(position.x, 0);
    point.writeInt32LE(position.y, 4);
    return user.symbols.MonitorFromPoint(
      point.readBigUInt64LE(),
      MONITOR_DEFAULTTONEAREST,
    );
  }

  private initialPlacement(options: WindowSpec["window"], window?: bigint) {
    if (!hasValidWindowPlacement(options)) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Invalid initial window placement.",
      });
    }
    const position =
      options.x != null && options.y != null
        ? {
            x: options.x,
            y: options.y,
          }
        : undefined;
    // Explicit placement keeps its point/primary work area even when the HWND overlaps another monitor.
    const usesDefaultPosition =
      !position && !options.center && !options.preventOverflow;
    const monitor = this.getPlacementMonitor(
      position,
      usesDefaultPosition ? window : undefined,
    );
    let dpi: number;
    if (window) {
      dpi = this.getDpi(window);
    } else {
      const x = new Uint32Array(1);
      const y = new Uint32Array(1);
      checkHresult(
        display.symbols.GetDpiForMonitor(monitor, 0, ptr(x), ptr(y)),
        "GetDpiForMonitor",
      );
      dpi = x[0] ?? 0;
      assert(dpi, "Monitor DPI is unavailable.");
    }
    const { style, exStyle } = initialWindowStyles(options);
    return initialWindowPlacement(
      options,
      dpi,
      this.outerSizeFor(0, 0, dpi, style, exStyle),
      this.getWorkArea(monitor),
    );
  }

  /** Own synchronous DPI transitions until initial geometry settles; reject cycles before showing. */
  private applyInitialPlacement(window: bigint, options: WindowSpec["window"]) {
    const attemptedDpis = new Set<number>();
    try {
      for (
        let attempt = 0;
        attempt < MAX_INITIAL_PLACEMENT_ATTEMPTS;
        attempt++
      ) {
        const dpi = this.readDpi(window);
        assert(
          !attemptedDpis.has(dpi),
          "Initial window placement cannot settle across monitor DPI changes.",
        );
        attemptedDpis.add(dpi);
        this.dpiByWindow.set(window, dpi);
        const actual = this.initialPlacement(options, window);
        // DefWindowProc otherwise clamps to system tracking limits, which can
        // shrink an oversized rectangle or enlarge an overflow-fitted one.
        this.initialOuterSizes.set(window, actual.outer);
        assert(
          user.symbols.SetWindowPos(
            window,
            0n,
            actual.position?.x ?? 0,
            actual.position?.y ?? 0,
            actual.outer.width,
            actual.outer.height,
            SWP_NOZORDER | SWP_NOACTIVATE | (actual.position ? 0 : SWP_NOMOVE),
          ),
          "Initial SetWindowPos failed.",
        );
        if (this.readDpi(window) === dpi) {
          const bounds = this.getBounds(window, "outer");
          assert(
            bounds.width === actual.outer.width &&
              bounds.height === actual.outer.height &&
              (!actual.position ||
                (bounds.x === actual.position.x &&
                  bounds.y === actual.position.y)),
            "Windows did not apply the initial window rectangle.",
          );
          return;
        }
      }
      throw new Error(
        "Initial window placement exceeded its DPI adjustment limit.",
      );
    } finally {
      this.initialOuterSizes.delete(window);
    }
  }

  /** Create hidden, apply content constraints and placement, register state, then optionally show. */
  create(
    title: string,
    width: number,
    height: number,
    receive: (message: number, wparam: bigint, lparam: bigint) => void,
    visible = true,
    options: SizeConstraints &
      WindowPlacement &
      Pick<
        WindowSpec["window"],
        | "maximized"
        | "fullscreen"
        | "focusable"
        | "titlebar"
        | "alwaysOnTop"
        | "skipTaskbar"
        | "contentProtection"
      > = {},
  ) {
    const { style, exStyle } = initialWindowStyles(options);
    const initialConstraints = resolvedConstraints(options);
    const placement = {
      ...options,
      width,
      height,
      ...initialConstraints,
    };
    const planned = this.initialPlacement(placement);
    // WM_GETMINMAXINFO can run before CreateWindowExW returns the HWND.
    this.creatingConstraints = initialConstraints;
    let window: bigint;
    try {
      window = withWide(title, (titlePointer) =>
        user.symbols.CreateWindowExW(
          Number(exStyle),
          ptr(this.name),
          titlePointer,
          Number(style),
          planned.position?.x ?? CW_USEDEFAULT,
          planned.position?.y ?? CW_USEDEFAULT,
          planned.outer.width,
          planned.outer.height,
          0n,
          0n,
          this.instance,
          null,
        ),
      );
    } finally {
      this.creatingConstraints = undefined;
    }
    assert(window, `CreateWindowExW: ${kernel.symbols.GetLastError()}`);
    this.windows.set(window, receive);
    this.constraints.set(window, initialConstraints);
    try {
      // Protect before the window is first shown, so no frame is ever capturable.
      if (options.contentProtection) {
        this.setContentProtection(window, true);
      }
      if (options.titlebar === "custom") {
        // CreateWindowEx can add WS_CAPTION to an overlapped window. Remove it
        // after creation while hidden, retaining overlapped placement and system-menu semantics.
        this.setStyle(window, this.windowStyles(window).style & ~WS_CAPTION);
        assert(
          user.symbols.SetWindowPos(
            window,
            0n,
            0,
            0,
            0,
            0,
            SWP_NOMOVE |
              SWP_NOSIZE |
              SWP_NOZORDER |
              SWP_NOACTIVATE |
              SWP_FRAMECHANGED,
          ),
        );
      }
      // The HWND's largest monitor overlap can differ from the requested point's monitor.
      // Recompute after every initial DPI transition, retaining the selected placement work area.
      this.applyInitialPlacement(window, placement);
      this.rememberNormalMonitor(window);
      if (options.maximized) {
        // Mark the hidden HWND as zoomed, retaining the normal rectangle before sizing its frame.
        // ShowWindow(SW_SHOWMAXIMIZED) would briefly display/activate deferred-ready windows.
        const normal = this.getPlacement(window);
        normal.writeUInt32LE(SW_SHOWMAXIMIZED, WINDOWPLACEMENT_SHOW_CMD_OFFSET);
        this.setStyle(window, this.windowStyles(window).style | WS_MAXIMIZE);
        this.setPlacement(window, normal, false, true);
        assert(
          this.isMaximized(window),
          "Initial maximized state was not applied.",
        );
      }
      if (options.fullscreen) {
        this.setFullscreen(window, true);
        const saved = this.fullscreen.get(window);
        assert(saved);
        saved.initial = true;
      }
      if (visible) {
        this.show(window, true);
      }
    } catch (error) {
      try {
        this.destroy(window);
      } catch (cleanupError) {
        throw new AggregateError(
          [
            error,
            cleanupError,
          ],
          "Window creation and cleanup failed.",
        );
      }
      throw error;
    }
    return window;
  }

  show(window: bigint, visible: boolean) {
    if (visible && !this.isFocusable(window)) {
      this.showInactive(window);
      return;
    }
    user.symbols.ShowWindow(window, visible ? SW_SHOW : SW_HIDE);
  }

  /** Show the existing placement without changing activation, even for hidden iconic or zoomed HWNDs. */
  showInactive(window: bigint): void {
    const minimized = this.isMinimized(window);
    const maximized = this.isMaximized(window);
    user.symbols.ShowWindow(window, SW_SHOWNA);
    assert(
      this.isVisible(window) &&
        this.isMinimized(window) === minimized &&
        this.isMaximized(window) === maximized,
      "Windows did not preserve the inactive window state.",
    );
    this.observeChanges(window);
  }

  /** Request foreground activation without showing or restoring; observe both sides of the transition. */
  activate(window: bigint): boolean {
    if (!this.isVisible(window) || this.isMinimized(window)) {
      return false;
    }
    if (!this.isFocusable(window)) {
      return this.isFocused(window);
    }
    user.symbols.SetForegroundWindow(window);
    // Synchronous activation callbacks can precede the actual foreground identity change.
    for (const observed of this.observations.keys()) {
      this.observeChanges(observed);
    }
    return this.isFocused(window);
  }

  focus(window: bigint): boolean {
    if (!this.isFocusable(window)) {
      return this.isFocused(window);
    }
    user.symbols.ShowWindow(
      window,
      user.symbols.IsIconic(window) ? SW_RESTORE : SW_SHOW,
    );
    return this.activate(window);
  }

  /** Restore a desktop Show request while respecting this HWND's activation policy. */
  showForDesktop(window: bigint): void {
    if (this.isFocusable(window)) {
      this.focus(window);
      return;
    }
    const minimized = this.isMinimized(window);
    if (minimized && !this.isFullscreen(window)) {
      // The normal restore API retains maximize history and uses inactive placement.
      this.restore(window);
      return;
    }
    if (minimized) {
      // Fullscreen remains owned by its saved placement; restore the native iconic
      // state without leaving fullscreen or requesting foreground activation.
      user.symbols.ShowWindow(window, SW_SHOWNOACTIVATE);
      this.observeChanges(window);
      return;
    }
    this.showInactive(window);
  }

  /** Read live HWND state; invalid handles must not be mistaken for false. */
  isMinimized(window: bigint): boolean {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    return user.symbols.IsIconic(window) !== 0;
  }

  isMaximized(window: bigint): boolean {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    return user.symbols.IsZoomed(window) !== 0;
  }

  isVisible(window: bigint): boolean {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    return user.symbols.IsWindowVisible(window) !== 0;
  }

  isFocused(window: bigint): boolean {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    return user.symbols.GetForegroundWindow() === window;
  }

  /** Read the normal caption mode even while fullscreen temporarily removes all decorations. */
  getTitlebar(window: bigint): "system" | "custom" {
    return (this.normalStyle(window) & WS_CAPTION) === WS_CAPTION
      ? "system"
      : "custom";
  }

  isAlwaysOnTop(window: bigint): boolean {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    return !!(this.windowStyles(window).exStyle & WS_EX_TOPMOST);
  }

  /** Change native Z order without altering activation, visibility or geometry. */
  setAlwaysOnTop(window: bigint, alwaysOnTop: boolean): void {
    if (this.isAlwaysOnTop(window) === alwaysOnTop) {
      return;
    }
    const HWND_TOPMOST = -1n;
    const HWND_NOTOPMOST = -2n;
    const SWP_NOOWNERZORDER = 0x200;
    assert(
      user.symbols.SetWindowPos(
        window,
        alwaysOnTop ? HWND_TOPMOST : HWND_NOTOPMOST,
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
      ),
    );
  }

  isSkipTaskbar(window: bigint): boolean {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    return !!(this.windowStyles(window).exStyle & WS_EX_TOOLWINDOW);
  }

  /** Tool-window style changes also change WINDOWPLACEMENT's coordinate convention.
   * Require a hidden normal window so no saved iconic/zoomed/fullscreen placement is reinterpreted.
   * Explorer observes the new style on the next explicit show without a hidden focus transfer.
   */
  setSkipTaskbar(window: bigint, skipTaskbar: boolean): void {
    if (this.isSkipTaskbar(window) === skipTaskbar) {
      return;
    }
    if (
      this.isVisible(window) ||
      this.isMinimized(window) ||
      this.isMaximized(window) ||
      this.isFullscreen(window)
    ) {
      throw new BunawayError({
        code: "BUSY",
        message: "Hide and restore the window before changing skipTaskbar.",
      });
    }
    const { exStyle } = this.windowStyles(window);
    const dpi = this.getDpi(window);
    const content = this.clientSizeInDips(window, dpi);
    this.changingGeometry.add(window);
    try {
      this.setStyle(
        window,
        skipTaskbar ? exStyle | WS_EX_TOOLWINDOW : exStyle & ~WS_EX_TOOLWINDOW,
        GWL_EXSTYLE,
      );
      // A tool window has a smaller system caption. Preserve exact client pixels
      // and constraints rather than allowing FRAMECHANGED to resize the content.
      this.setClientSize(window, content, dpi, true);
      this.rememberNormalMonitor(window);
    } finally {
      this.changingGeometry.delete(window);
      this.observeChanges(window);
    }
  }

  /**
   * Read the OS display affinity, which is the source of truth. It reflects which level
   * the setter's fallback applied, and keeping no separate managed state avoids drift.
   */
  isContentProtected(window: bigint): boolean {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    const affinity = Buffer.alloc(4);
    assert(
      user.symbols.GetWindowDisplayAffinity(window, ptr(affinity)),
      `GetWindowDisplayAffinity: ${kernel.symbols.GetLastError()}`,
    );
    return affinity.readUInt32LE(0) !== WDA_NONE;
  }

  /**
   * Exclude the window from screenshots and screen sharing. WDA_EXCLUDEFROMCAPTURE omits the
   * window from captures; Windows 10 before version 2004 treats it like WDA_MONITOR, which keeps
   * the window in captures with black content. If the call is rejected, it is retried with
   * WDA_MONITOR. Fails when neither affinity can be applied.
   */
  setContentProtection(window: bigint, enabled: boolean): void {
    if (this.isContentProtected(window) === enabled) {
      return;
    }
    if (!enabled) {
      assert(
        user.symbols.SetWindowDisplayAffinity(window, WDA_NONE),
        `SetWindowDisplayAffinity: ${kernel.symbols.GetLastError()}`,
      );
      return;
    }
    if (user.symbols.SetWindowDisplayAffinity(window, WDA_EXCLUDEFROMCAPTURE)) {
      return;
    }
    assert(
      user.symbols.SetWindowDisplayAffinity(window, WDA_MONITOR),
      `Content protection is unavailable: ${kernel.symbols.GetLastError()}`,
    );
  }

  /**
   * Read the live constant window alpha as 0..1 from the OS. A window without the layered
   * style or without an alpha attribute is fully opaque. The value is quantized to the
   * 8-bit alpha the OS stores, so it can differ slightly from the value that was set.
   */
  getOpacity(window: bigint): number {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    if (!(this.windowStyles(window).exStyle & WS_EX_LAYERED)) {
      return 1;
    }
    const alpha = Buffer.alloc(1);
    const flags = Buffer.alloc(4);
    // A layered window that never received attributes makes this call fail; it is opaque.
    if (
      !user.symbols.GetLayeredWindowAttributes(
        window,
        null,
        ptr(alpha),
        ptr(flags),
      )
    ) {
      return 1;
    }
    return flags.readUInt32LE(0) & LWA_ALPHA
      ? alpha.readUInt8(0) / MAX_ALPHA
      : 1;
  }

  /**
   * Set whole-window opacity (0 transparent, 1 opaque) through a layered window, which also
   * covers the WebView child. The layered style is added only while the window is translucent
   * and removed at full opacity unless the window ignores mouse input, so an opaque window keeps its normal rendering path.
   */
  setOpacity(window: bigint, opacity: number): void {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    assert(
      Number.isFinite(opacity) && opacity >= 0 && opacity <= 1,
      "Opacity must be between 0 and 1.",
    );
    const alpha = Math.round(opacity * MAX_ALPHA);
    const { exStyle } = this.windowStyles(window);
    // Click-through needs the layered style, so full opacity keeps it while the window
    // ignores the mouse and only resets the alpha to opaque.
    if (alpha === MAX_ALPHA && !(exStyle & WS_EX_TRANSPARENT)) {
      if (exStyle & WS_EX_LAYERED) {
        this.setStyle(window, exStyle & ~WS_EX_LAYERED, GWL_EXSTYLE);
      }
      return;
    }
    const wasLayered = !!(exStyle & WS_EX_LAYERED);
    if (!wasLayered) {
      this.setStyle(window, exStyle | WS_EX_LAYERED, GWL_EXSTYLE);
    }
    if (!user.symbols.SetLayeredWindowAttributes(window, 0, alpha, LWA_ALPHA)) {
      const error = kernel.symbols.GetLastError();
      // A layered window without attributes is not drawn, so undo the style we added.
      if (!wasLayered) {
        this.setStyle(window, exStyle, GWL_EXSTYLE);
      }
      assert(false, `SetLayeredWindowAttributes: ${error}`);
    }
  }

  /** Whether the window lets mouse input pass through to whatever is beneath it. */
  isIgnoreMouseEvents(window: bigint): boolean {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    return !!(this.windowStyles(window).exStyle & WS_EX_TRANSPARENT);
  }

  /**
   * Make the whole window, WebView included, transparent to mouse hit testing. A window that
   * is both layered and WS_EX_TRANSPARENT is skipped by the hit test, so clicks reach the
   * window beneath. The layered style is shared with opacity: it is added with a fully
   * opaque alpha (a layered window without attributes is not drawn) and only removed when
   * the window is also fully opaque. Keyboard focus and activation are not changed.
   */
  setIgnoreMouseEvents(window: bigint, ignore: boolean): void {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    const { exStyle } = this.windowStyles(window);
    if (!!(exStyle & WS_EX_TRANSPARENT) === ignore) {
      return;
    }
    if (ignore) {
      const wasLayered = !!(exStyle & WS_EX_LAYERED);
      this.setStyle(
        window,
        exStyle | WS_EX_LAYERED | WS_EX_TRANSPARENT,
        GWL_EXSTYLE,
      );
      if (
        !wasLayered &&
        !user.symbols.SetLayeredWindowAttributes(
          window,
          0,
          MAX_ALPHA,
          LWA_ALPHA,
        )
      ) {
        const error = kernel.symbols.GetLastError();
        this.setStyle(window, exStyle, GWL_EXSTYLE);
        assert(false, `SetLayeredWindowAttributes: ${error}`);
      }
      return;
    }
    const restored = exStyle & ~WS_EX_TRANSPARENT;
    this.setStyle(
      window,
      this.getOpacity(window) === 1 ? restored & ~WS_EX_LAYERED : restored,
      GWL_EXSTYLE,
    );
  }

  /**
   * Flash only the taskbar button, leaving the caption (and any custom titlebar)
   * untouched. Never activates, shows or reorders the window. A hidden, skipTaskbar
   * or owned window has no taskbar button, so nothing visible flashes but the call
   * still succeeds. `untilFocused` on the foreground window stops immediately.
   * Repeated calls replace the previous mode. Throws if the window is destroyed or
   * FlashWindowEx reports a failure through the last error (see `flash`).
   */
  requestAttention(window: bigint, mode: WindowAttentionMode): void {
    this.flash(
      window,
      FLASHW_TRAY | (mode === "continuous" ? FLASHW_TIMER : FLASHW_TIMERNOFG),
    );
  }

  /** Stop flashing and restore the taskbar button; succeeds when not flashing. */
  cancelAttention(window: bigint): void {
    this.flash(window, FLASHW_STOP);
  }

  private flash(window: bigint, flags: number): void {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    const info = Buffer.alloc(FLASHWINFO_SIZE);
    info.writeUInt32LE(FLASHWINFO_SIZE, 0); // cbSize
    info.writeBigUInt64LE(window, 8); // hwnd
    info.writeUInt32LE(flags, 16); // dwFlags
    // uCount and dwTimeout stay 0: flash until stopped at the system blink rate.
    // The return value is the previous caption-active state, so 0 is a normal result
    // for an inactive window. Failure is visible only through the last error, which
    // is cleared first so a stale error from an earlier call cannot be reported.
    kernel.symbols.SetLastError(0);
    const previousCaptionActive = user.symbols.FlashWindowEx(ptr(info));
    const error =
      previousCaptionActive === 0 ? kernel.symbols.GetLastError() : 0;
    assert(error === 0, `FlashWindowEx: ${error}`);
  }

  isFocusable(window: bigint): boolean {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    return !(this.windowStyles(window).exStyle & WS_EX_NOACTIVATE);
  }

  /** Set native no-activation style without showing, resizing or transferring existing focus. */
  setFocusable(window: bigint, focusable: boolean): void {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    const { exStyle } = this.windowStyles(window);
    const next = focusable
      ? exStyle & ~WS_EX_NOACTIVATE
      : exStyle | WS_EX_NOACTIVATE;
    if (next === exStyle) {
      return;
    }
    this.setStyle(window, next, GWL_EXSTYLE);
    assert(
      user.symbols.SetWindowPos(
        window,
        0n,
        0,
        0,
        0,
        0,
        SWP_NOSIZE |
          SWP_NOMOVE |
          SWP_NOZORDER |
          SWP_NOACTIVATE |
          SWP_FRAMECHANGED,
      ),
    );
  }

  private normalStyle(window: bigint): bigint {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    return (
      this.fullscreen.get(window)?.style ?? this.windowStyles(window).style
    );
  }

  /** Update caption-button styles without changing geometry, activation or the fullscreen frame. */
  private setCaptionButton(
    window: bigint,
    flag: bigint,
    enabled: boolean,
  ): void {
    const style = this.normalStyle(window);
    const next = enabled ? style | flag : style & ~flag;
    if (next === style) {
      return;
    }
    const fullscreen = this.fullscreen.get(window);
    if (fullscreen) {
      fullscreen.style = next;
      return;
    }
    this.setStyle(window, next);
    assert(
      user.symbols.SetWindowPos(
        window,
        0n,
        0,
        0,
        0,
        0,
        SWP_NOSIZE |
          SWP_NOMOVE |
          SWP_NOZORDER |
          SWP_NOACTIVATE |
          SWP_FRAMECHANGED,
      ),
    );
  }

  isMinimizable(window: bigint): boolean {
    return !!(this.normalStyle(window) & WS_MINIMIZEBOX);
  }
  setMinimizable(window: bigint, minimizable: boolean): void {
    this.setCaptionButton(window, WS_MINIMIZEBOX, minimizable);
  }
  isMaximizable(window: bigint): boolean {
    return !!(this.normalStyle(window) & WS_MAXIMIZEBOX);
  }
  setMaximizable(window: bigint, maximizable: boolean): void {
    this.setCaptionButton(window, WS_MAXIMIZEBOX, maximizable);
  }
  isFullscreenable(window: bigint): boolean {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    return !this.nonFullscreenable.has(window);
  }

  /** Store whether fullscreen may be entered. A current fullscreen is kept and can still be exited. */
  setFullscreenable(window: bigint, fullscreenable: boolean): void {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    if (fullscreenable) {
      this.nonFullscreenable.delete(window);
    } else {
      this.nonFullscreenable.add(window);
    }
  }

  isClosable(window: bigint): boolean {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    return this.closeControls.get(window) ?? true;
  }

  /** Store user closing policy and keep the native Close command/button in sync. */
  setClosable(window: bigint, closable: boolean): void {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    this.closeControls.set(window, closable);
    if (!this.isFullscreen(window)) {
      this.applyCloseButton(window);
    }
  }

  private applyCloseButton(window: bigint): void {
    const menu = user.symbols.GetSystemMenu(window, 0);
    assert(menu, "Native system menu is unavailable.");
    assert(
      user.symbols.EnableMenuItem(
        menu,
        SC_CLOSE,
        this.isClosable(window) ? MF_ENABLED : MF_GRAYED,
      ) !== MENU_ITEM_ERROR,
      "Native close control could not be updated.",
    );
    assert(
      user.symbols.DrawMenuBar(window),
      "Native caption could not be redrawn.",
    );
  }

  /** Apply a UTF-16 native caption without activating, showing or resizing the window. */
  setTitle(window: bigint, title: string): void {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    assert(
      withWide(title, (text) => user.symbols.SetWindowTextW(window, text)),
      `SetWindowTextW: ${kernel.symbols.GetLastError()}`,
    );
  }

  /** Set the screen reader name apart from the caption; "" restores the caption. */
  setAccessibleTitle(window: bigint, title: string): void {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    this.accessibleTitles.set(window, title);
  }

  /** Read the last accessible title applied in this process, or null when none is set. */
  getAccessibleTitle(window: bigint): string | null {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    return this.accessibleTitles.get(window);
  }

  /** Read live native text with a fixed bound; empty captions are valid native query results. */
  getTitle(window: bigint): string {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    kernel.symbols.SetLastError(0);
    const length = user.symbols.GetWindowTextLengthW(window);
    const lengthError = kernel.symbols.GetLastError();
    assert(
      length !== 0 || lengthError === 0,
      `GetWindowTextLengthW: ${lengthError}`,
    );
    assert(
      length <= MAX_WINDOW_TITLE_LENGTH,
      "Native window title exceeds the supported length.",
    );
    // One extra code unit detects a caption growing between the length query and copy.
    const text = Buffer.alloc((MAX_WINDOW_TITLE_LENGTH + 2) * 2);
    kernel.symbols.SetLastError(0);
    const copied = user.symbols.GetWindowTextW(
      window,
      ptr(text),
      MAX_WINDOW_TITLE_LENGTH + 2,
    );
    const error = kernel.symbols.GetLastError();
    assert(copied !== 0 || error === 0, `GetWindowTextW: ${error}`);
    assert(
      copied <= MAX_WINDOW_TITLE_LENGTH,
      "Native window title exceeds the supported length.",
    );
    return text.toString("utf16le", 0, copied * 2);
  }

  /** Read the resize style restored after fullscreen, rather than the borderless fullscreen style. */
  isResizable(window: bigint): boolean {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    return !!(
      (this.fullscreen.get(window)?.style ?? this.windowStyles(window).style) &
      WS_THICKFRAME
    );
  }

  /** Change user resizing while retaining normal content size, display state and input focus. */
  setResizable(window: bigint, resizable: boolean): void {
    if (this.isResizable(window) === resizable) {
      return;
    }
    const fullscreen = this.fullscreen.get(window);
    const style = fullscreen?.style ?? this.windowStyles(window).style;
    const nextStyle = resizable
      ? style | WS_THICKFRAME
      : style & ~WS_THICKFRAME;
    if (fullscreen) {
      fullscreen.style = nextStyle;
      this.resizePlacement(
        window,
        fullscreen.placement,
        fullscreen.restoreSize,
        this.getSizeConstraints(window),
        fullscreen.dpi,
        nextStyle,
      );
      return;
    }
    const dpi = this.getDpi(window);
    const placement =
      this.isMinimized(window) || this.isMaximized(window)
        ? this.getPlacement(window)
        : undefined;
    const content = placement
      ? this.clientSizeFromPlacement(window, placement, dpi, style)
      : this.clientSizeInDips(window, dpi);
    this.changingGeometry.add(window);
    try {
      this.setStyle(window, nextStyle);
      assert(
        user.symbols.SetWindowPos(
          window,
          0n,
          0,
          0,
          0,
          0,
          SWP_NOSIZE |
            SWP_NOMOVE |
            SWP_NOZORDER |
            SWP_NOACTIVATE |
            SWP_FRAMECHANGED,
        ),
      );
      if (placement) {
        this.resizePlacement(
          window,
          placement,
          content,
          this.getSizeConstraints(window),
          dpi,
          nextStyle,
        );
        this.setPlacement(window, placement, this.isVisible(window), true);
      } else {
        this.setClientSize(
          window,
          clampWindowSize(
            content.width,
            content.height,
            this.getSizeConstraints(window),
          ),
          dpi,
        );
      }
    } finally {
      this.changingGeometry.delete(window);
      this.observeChanges(window);
    }
  }

  isMovable(window: bigint): boolean {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    return !this.immovable.has(window);
  }

  /** Block user movement only. Geometry APIs, display changes and fullscreen can still reposition. */
  setMovable(window: bigint, movable: boolean): void {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    if (movable) {
      this.immovable.delete(window);
    } else {
      this.immovable.add(window);
    }
  }

  /** Own one native observer per window. Its callback ends before HWND destruction. No initial replay. */
  observe(
    window: bigint,
    viewId: string,
    receive: (snapshot: WindowSnapshot, changes: WindowChange[]) => void,
  ): void {
    assert(!this.observations.has(window), "Window already observed.");
    this.observations.set(window, {
      snapshot: this.readSnapshot(
        window,
        `window-${crypto.randomUUID()}`,
        viewId,
        0,
      ),
      receive,
    });
  }

  private readSnapshot(
    window: bigint,
    windowId: string,
    viewId: string,
    revision: number,
  ): WindowSnapshot {
    return {
      windowId,
      viewId,
      revision,
      state: {
        visible: this.isVisible(window),
        focused: this.isFocused(window),
        minimized: this.isMinimized(window),
        maximized: this.isMaximized(window),
        fullscreen: this.isFullscreen(window),
        alwaysOnTop: this.isAlwaysOnTop(window),
      },
      bounds: this.getBounds(window, "outer"),
    };
  }

  /** Commit before calling the observer so nested Win32 callbacks cannot repeat a transition. */
  private observeChanges(window: bigint, completed?: WindowBounds): void {
    const observation = this.observations.get(window);
    if (!observation || this.changingGeometry.has(window)) {
      return;
    }
    const previous = observation.snapshot;
    const current = this.readSnapshot(
      window,
      previous.windowId,
      previous.viewId,
      previous.revision + 1,
    );
    const changes = windowChanges(previous, current);
    if (completed) {
      changes.push(...completedGeometryChanges(completed, current.bounds));
    }
    if (!changes.length) {
      return;
    }
    observation.snapshot = current;
    observation.receive(current, changes);
    if (previous.state.alwaysOnTop !== current.state.alwaysOnTop) {
      // Win32 can change topmost on related owner and owned windows in one
      // Z-order operation, and those windows may not receive their own
      // position message. Re-read them so their committed snapshots match.
      // Unchanged snapshots are suppressed, and a nested pass only fans out
      // again after a new topmost commit, so the recursion ends.
      for (const other of [
        ...this.observations.keys(),
      ]) {
        if (other !== window && user.symbols.IsWindow(other)) {
          this.observeChanges(other);
        }
      }
    }
  }

  /** Query using the same committed revision as events, including changes awaiting a native message. */
  getSnapshot(window: bigint): WindowSnapshot {
    this.observeChanges(window);
    const snapshot = this.observations.get(window)?.snapshot;
    assert(snapshot, "Window is not observed.");
    return {
      ...snapshot,
      state: {
        ...snapshot.state,
      },
      bounds: {
        ...snapshot.bounds,
      },
    };
  }

  /** Return only immutable identity, without sampling bounds, emitting events or activating a window. */
  private identity(window: bigint): WindowIdentity | null {
    const snapshot = this.observations.get(window)?.snapshot;
    return snapshot
      ? {
          windowId: snapshot.windowId,
          viewId: snapshot.viewId,
        }
      : null;
  }

  /** Resolve an observed native lifetime without sampling or publishing window changes. */
  getById(windowId: string): WindowIdentity | null {
    for (const [window, observation] of this.observations) {
      if (observation.snapshot.windowId === windowId) {
        return this.identity(window);
      }
    }
    return null;
  }

  /** Resolve the single native window currently owned by this policy view. */
  getByView(viewId: string): WindowIdentity | null {
    for (const [window, observation] of this.observations) {
      if (observation.snapshot.viewId === viewId) {
        return this.identity(window);
      }
    }
    return null;
  }

  /** An external foreground window means no focused window in this host. */
  getFocused(): WindowIdentity | null {
    return this.identity(user.symbols.GetForegroundWindow());
  }

  /** Activation history has no fallback when its most recent window is destroyed. */
  getLastActive(): WindowIdentity | null {
    return this.lastActiveWindow === null
      ? null
      : this.identity(this.lastActiveWindow);
  }

  /** Uses Win32 ownership for top-level windows, never WS_CHILD embedding. */
  setOwner(window: bigint, owner: bigint) {
    user.symbols.SetWindowLongPtrW(window, GWLP_HWNDPARENT, owner);
    // The setter can invoke our WndProc, which uses Win32 APIs and changes last-error state.
    assert.equal(this.getOwner(window), owner, "Windows did not apply owner");
  }

  getOwner(window: bigint): bigint {
    return user.symbols.GetWindow(window, GW_OWNER);
  }

  /** EnableWindow returns the previous disabled state; verify the resulting state. */
  setEnabled(window: bigint, enabled: boolean) {
    user.symbols.EnableWindow(window, enabled ? 1 : 0);
    assert.equal(
      this.isEnabled(window),
      enabled,
      "Windows did not apply enabled state",
    );
  }

  isEnabled(window: bigint): boolean {
    return !!user.symbols.IsWindowEnabled(window);
  }

  /** ShowWindow returns previous visibility, so verify the requested native state instead. */
  private changeShowState(
    window: bigint,
    command: number,
    minimized: boolean,
    maximized: boolean,
  ) {
    assert(
      !this.isFullscreen(window),
      "Exit fullscreen before changing window state.",
    );
    if (this.isFocusable(window)) {
      user.symbols.ShowWindow(window, command);
    } else {
      this.changingGeometry.add(window);
      try {
        if (minimized) {
          user.symbols.ShowWindow(window, SW_SHOWMINNOACTIVE);
        } else {
          const placement = this.getPlacement(window);
          // SHOWNA preserves the native iconic state even after its style bit is
          // cleared. Restore that state without activation before zooming again.
          if (
            this.isMinimized(window) ||
            (!maximized && this.isMaximized(window))
          ) {
            user.symbols.ShowWindow(window, SW_SHOWNOACTIVATE);
          }
          const { style } = this.windowStyles(window);
          this.setStyle(
            window,
            (style & ~WS_MINIMIZE & ~WS_MAXIMIZE) |
              (maximized ? WS_MAXIMIZE : 0n),
          );
          placement.writeUInt32LE(
            maximized ? SW_SHOWMAXIMIZED : SW_SHOWNOACTIVATE,
            WINDOWPLACEMENT_SHOW_CMD_OFFSET,
          );
          if (!maximized) {
            placement.writeUInt32LE(
              placement.readUInt32LE(WINDOWPLACEMENT_FLAGS_OFFSET) &
                ~WPF_RESTORETOMAXIMIZED,
              WINDOWPLACEMENT_FLAGS_OFFSET,
            );
          }
          // A zoomed HWND uses SHOWNA plus an explicit work-area resize. Normal restoration
          // uses SHOWNOACTIVATE so neither transition calls the OS foreground activator.
          this.setPlacement(window, placement, true, maximized);
        }
      } finally {
        this.changingGeometry.delete(window);
        this.observeChanges(window);
      }
    }
    assert(
      this.isVisible(window) &&
        this.isMinimized(window) === minimized &&
        this.isMaximized(window) === maximized,
      "Windows did not apply the requested window state.",
    );
  }

  minimize(window: bigint) {
    this.changeShowState(window, SW_MINIMIZE, true, false);
  }

  maximize(window: bigint) {
    this.changeShowState(window, SW_SHOWMAXIMIZED, false, true);
  }

  /** Normal restoration deliberately discards the minimized window's maximize history. */
  unmaximize(window: bigint) {
    this.changeShowState(window, SW_SHOWNORMAL, false, false);
  }

  /** Honor Windows' restore-to-maximized flag only when restoring a minimized window. */
  restore(window: bigint) {
    const restoreMaximized =
      this.isMinimized(window) &&
      (this.getPlacement(window).readUInt32LE(WINDOWPLACEMENT_FLAGS_OFFSET) &
        WPF_RESTORETOMAXIMIZED) !==
        0;
    this.changeShowState(window, SW_RESTORE, false, restoreMaximized);
  }

  toggleMaximize(window: bigint) {
    if (this.isMaximized(window)) {
      this.unmaximize(window);
    } else {
      this.maximize(window);
    }
  }

  /** Apply clamped logical dimensions and resize saved normal placement. */
  setSize(window: bigint, width: number, height: number) {
    const constraints = this.constraints.get(window) ?? resolvedConstraints();
    const size = clampWindowSize(width, height, constraints);
    const fullscreen = this.fullscreen.get(window);
    if (fullscreen) {
      fullscreen.restoreSize = size;
      this.resizePlacement(
        window,
        fullscreen.placement,
        size,
        constraints,
        fullscreen.dpi,
        fullscreen.style,
      );
      return;
    }
    if (user.symbols.IsIconic(window) || user.symbols.IsZoomed(window)) {
      const placement = this.getPlacement(window);
      this.resizePlacement(
        window,
        placement,
        size,
        constraints,
        this.getDpi(window),
      );
      this.setPlacement(window, placement);
      return;
    }
    this.setClientSize(window, size, this.getDpi(window));
  }

  getSizeConstraints(window: bigint): WindowSizeConstraints {
    const constraints = this.constraints.get(window) ?? resolvedConstraints();
    return {
      ...constraints,
    };
  }

  /** Replace limits and reclamp current or saved normal client size. */
  setSizeConstraints(window: bigint, constraints: WindowSizeConstraints) {
    assert(
      hasValidWindowSizeConstraints(constraints),
      "Invalid window size constraints.",
    );
    const resolved = {
      ...constraints,
    };
    this.constraints.set(window, resolved);
    const fullscreen = this.fullscreen.get(window);
    if (fullscreen) {
      fullscreen.restoreSize = clampWindowSize(
        fullscreen.restoreSize.width,
        fullscreen.restoreSize.height,
        resolved,
      );
      this.resizePlacement(
        window,
        fullscreen.placement,
        fullscreen.restoreSize,
        resolved,
        fullscreen.dpi,
        fullscreen.style,
      );
      return;
    }
    if (user.symbols.IsIconic(window) || user.symbols.IsZoomed(window)) {
      const placement = this.getPlacement(window);
      this.resizePlacement(
        window,
        placement,
        this.clientSizeFromPlacement(window, placement, this.getDpi(window)),
        resolved,
        this.getDpi(window),
      );
      this.setPlacement(
        window,
        placement,
        user.symbols.IsWindowVisible(window) !== 0,
        true,
      );
      return;
    }
    const size = this.clientSizeInDips(window, this.getDpi(window));
    this.setClientSize(
      window,
      clampWindowSize(size.width, size.height, resolved),
      this.getDpi(window),
    );
  }

  private readDpi(window: bigint) {
    const dpi = user.symbols.GetDpiForWindow(window);
    assert(dpi, `GetDpiForWindow: ${kernel.symbols.GetLastError()}`);
    return dpi;
  }

  /** Read the DPI committed by the latest native DPI message. */
  getDpi(window: bigint) {
    return this.dpiByWindow.get(window) ?? this.readDpi(window);
  }

  /** Keep the normal monitor before iconic, maximized or fullscreen geometry replaces it. */
  private rememberNormalMonitor(window: bigint) {
    if (
      this.fullscreen.has(window) ||
      user.symbols.IsIconic(window) ||
      user.symbols.IsZoomed(window)
    ) {
      return;
    }
    const monitor = user.symbols.MonitorFromWindow(
      window,
      MONITOR_DEFAULTTONEAREST,
    );
    assert(monitor, "Normal window monitor is unavailable.");
    const info = Buffer.alloc(MONITORINFO_SIZE);
    info.writeUInt32LE(MONITORINFO_SIZE);
    assert(user.symbols.GetMonitorInfoW(monitor, ptr(info)));
    this.normalMonitors.set(window, {
      display: monitor,
      screenRect: info.subarray(4, 4 + RECT_SIZE),
    });
  }

  /**
   * Resolve the normal monitor, caching replacements outside fullscreen.
   * Return undefined when no display can be queried; the next display change or query retries.
   */
  private readNormalMonitorInfo(
    window: bigint,
    rect: Buffer,
  ): Buffer | undefined {
    const normalMonitor = this.normalMonitors.get(window);
    assert(normalMonitor, "Normal window monitor is unavailable.");
    const info = Buffer.alloc(MONITORINFO_SIZE);
    info.writeUInt32LE(MONITORINFO_SIZE);
    if (user.symbols.GetMonitorInfoW(normalMonitor.display, ptr(info))) {
      return info;
    }
    const fullscreen = this.fullscreen.has(window);
    // Workspace coordinates cannot identify the screen monitor at a shared edge.
    const display = user.symbols.MonitorFromRect(
      ptr(fullscreen ? normalMonitor.screenRect : rect),
      MONITOR_DEFAULTTONEAREST,
    );
    if (!display || !user.symbols.GetMonitorInfoW(display, ptr(info))) {
      return undefined;
    }
    // Fullscreen retains its original placement, so its fallback monitor is temporary.
    if (!fullscreen) {
      this.normalMonitors.set(window, {
        display,
        screenRect: info.subarray(4, 4 + RECT_SIZE),
      });
    }
    return info;
  }

  /**
   * Snapshot client or outer screen geometry without changing visibility or state.
   * Minimized current bounds are the native iconic bounds; normal bounds remain restorable.
   */
  getBounds(
    window: bigint,
    area: "content" | "outer" | "normal",
  ): WindowBounds {
    const dpi = this.getDpi(window);
    if (area === "normal") {
      const saved = this.fullscreen.get(window);
      const placement = saved
        ? Buffer.from(saved.placement)
        : this.getPlacement(window);
      if (saved) {
        // Match fullscreen exit's size projection without modifying the saved placement.
        this.resizePlacement(
          window,
          placement,
          saved.restoreSize,
          this.getSizeConstraints(window),
          dpi,
          saved.style,
        );
      }
      const rect = placement.subarray(WINDOWPLACEMENT_NORMAL_RECT_OFFSET);
      let x = rect.readInt32LE(0);
      let y = rect.readInt32LE(4);
      const { exStyle } = this.windowStyles(window);
      if (!(exStyle & WS_EX_TOOLWINDOW)) {
        const monitor = this.readNormalMonitorInfo(window, rect);
        assert(monitor, "Normal window monitor is unavailable.");
        // WINDOWPLACEMENT uses workspace coordinates; callers use screen coordinates.
        x += monitor.readInt32LE(20) - monitor.readInt32LE(4);
        y += monitor.readInt32LE(24) - monitor.readInt32LE(8);
      }
      return {
        x,
        y,
        width: rect.readInt32LE(8) - rect.readInt32LE(0),
        height: rect.readInt32LE(12) - rect.readInt32LE(4),
        dpi,
      };
    }
    if (area === "content") {
      const point = Buffer.alloc(8);
      assert(user.symbols.ClientToScreen(window, ptr(point)));
      return {
        x: point.readInt32LE(0),
        y: point.readInt32LE(4),
        ...this.clientSize(window),
        dpi,
      };
    }
    const rect = Buffer.alloc(RECT_SIZE);
    assert(user.symbols.GetWindowRect(window, ptr(rect)));
    return {
      x: rect.readInt32LE(0),
      y: rect.readInt32LE(4),
      width: rect.readInt32LE(8) - rect.readInt32LE(0),
      height: rect.readInt32LE(12) - rect.readInt32LE(4),
      dpi,
    };
  }

  private clientSize(window: bigint): ClientSize {
    const rect = Buffer.alloc(RECT_SIZE);
    assert(user.symbols.GetClientRect(window, ptr(rect)));
    return {
      width: rect.readInt32LE(8) - rect.readInt32LE(0),
      height: rect.readInt32LE(12) - rect.readInt32LE(4),
    };
  }

  private clientSizeInDips(window: bigint, dpi: number): ClientSize {
    const size = this.clientSize(window);
    // Preserve fractional DIPs internally so frame changes can recover the exact
    // physical client pixels. Public logical geometry queries round separately.
    return {
      width: (size.width * DEFAULT_DPI) / dpi,
      height: (size.height * DEFAULT_DPI) / dpi,
    };
  }

  private outerSizeFor(
    width: number,
    height: number,
    dpi: number,
    style: bigint,
    exStyle: bigint,
    hasMenu = false,
  ): ClientSize {
    const rect = new Int32Array([
      0,
      0,
      physicalPixels(width, dpi),
      physicalPixels(height, dpi),
    ]);
    assert(
      user.symbols.AdjustWindowRectExForDpi(
        ptr(rect),
        Number(style),
        hasMenu ? 1 : 0,
        Number(exStyle),
        dpi,
      ),
    );
    return {
      width: (rect[2] ?? 0) - (rect[0] ?? 0),
      height: (rect[3] ?? 0) - (rect[1] ?? 0),
    };
  }

  private windowStyles(window: bigint) {
    return {
      style: user.symbols.GetWindowLongPtrW(window, GWL_STYLE),
      exStyle: user.symbols.GetWindowLongPtrW(window, GWL_EXSTYLE),
    };
  }

  private setStyle(window: bigint, style: bigint, index = GWL_STYLE) {
    kernel.symbols.SetLastError(0);
    const previousStyle = user.symbols.SetWindowLongPtrW(window, index, style);
    const error = kernel.symbols.GetLastError();
    assert(previousStyle !== 0n || error === 0, `SetWindowLongPtrW: ${error}`);
  }

  private setClientSize(
    window: bigint,
    size: ClientSize,
    dpi: number,
    frameChanged = false,
  ) {
    const { style, exStyle } = this.windowStyles(window);
    const outerSize = this.outerSizeFor(
      size.width,
      size.height,
      dpi,
      style,
      exStyle,
      user.symbols.GetMenu(window) !== 0n,
    );
    assert(
      user.symbols.SetWindowPos(
        window,
        0n,
        0,
        0,
        outerSize.width,
        outerSize.height,
        SWP_NOMOVE |
          SWP_NOZORDER |
          SWP_NOACTIVATE |
          (frameChanged ? SWP_FRAMECHANGED : 0),
      ),
    );
    if (user.symbols.GetMenu(window)) {
      // AdjustWindowRectExForDpi counts one menu row. After width settles, account
      // for native wrapping without moving or activating the owner.
      const actual = this.clientSize(window);
      const missingHeight = physicalPixels(size.height, dpi) - actual.height;
      if (missingHeight !== 0) {
        const outer = this.getBounds(window, "outer");
        assert(
          user.symbols.SetWindowPos(
            window,
            0n,
            0,
            0,
            outer.width,
            outer.height + missingHeight,
            SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
          ),
        );
      }
    }
  }

  private getPlacement(window: bigint) {
    const placement = Buffer.alloc(WINDOWPLACEMENT_SIZE);
    placement.writeUInt32LE(WINDOWPLACEMENT_SIZE);
    assert(user.symbols.GetWindowPlacement(window, ptr(placement)));
    // Maximize history is only valid when restoring a minimized placement.
    if (
      placement.readUInt32LE(WINDOWPLACEMENT_SHOW_CMD_OFFSET) !==
      SW_SHOWMINIMIZED
    ) {
      placement.writeUInt32LE(
        placement.readUInt32LE(WINDOWPLACEMENT_FLAGS_OFFSET) &
          ~WPF_RESTORETOMAXIMIZED,
        WINDOWPLACEMENT_FLAGS_OFFSET,
      );
    }
    return placement;
  }

  private setPlacement(
    window: bigint,
    placement: Buffer,
    visible = user.symbols.IsWindowVisible(window) !== 0,
    recomputeMaximizedSize = false,
  ) {
    const maximized =
      placement.readUInt32LE(WINDOWPLACEMENT_SHOW_CMD_OFFSET) ===
        SW_SHOWMAXIMIZED && user.symbols.IsZoomed(window) !== 0;
    const update = Buffer.from(placement);
    if (maximized || !visible) {
      // Placement does not record hiding. Hide before applying it so a saved
      // show command cannot briefly display or activate a background HWND.
      update.writeUInt32LE(
        visible ? SW_SHOWNA : SW_HIDE,
        WINDOWPLACEMENT_SHOW_CMD_OFFSET,
      );
    }
    assert(user.symbols.SetWindowPlacement(window, ptr(update)));
    if (maximized && recomputeMaximizedSize) {
      // SW_SHOWMAXIMIZED cannot recalculate the size of an already zoomed HWND.
      this.resizeMaximized(window);
    }
  }

  private resizeMaximized(window: bigint) {
    const monitor = Buffer.alloc(MONITORINFO_SIZE);
    monitor.writeUInt32LE(MONITORINFO_SIZE);
    assert(
      user.symbols.GetMonitorInfoW(
        user.symbols.MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST),
        ptr(monitor),
      ),
    );
    const dpi = this.readDpi(window);
    const padding = user.symbols.GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
    const borderWidth =
      user.symbols.GetSystemMetricsForDpi(SM_CXSIZEFRAME, dpi) + padding;
    const borderHeight =
      user.symbols.GetSystemMetricsForDpi(SM_CYSIZEFRAME, dpi) + padding;
    // Maximized resize borders sit outside the work area. WINDOWPOS applies
    // the app's client constraints without changing the saved normal rect.
    const left = monitor.readInt32LE(20);
    const top = monitor.readInt32LE(24);
    assert(
      user.symbols.SetWindowPos(
        window,
        0n,
        left - borderWidth,
        top - borderHeight,
        monitor.readInt32LE(28) - left + 2 * borderWidth,
        monitor.readInt32LE(32) - top + 2 * borderHeight,
        SWP_NOZORDER | SWP_NOACTIVATE,
      ),
    );
  }

  private clientSizeFromPlacement(
    window: bigint,
    placement: Buffer,
    dpi: number,
    style = user.symbols.GetWindowLongPtrW(window, GWL_STYLE),
  ): ClientSize {
    const rectOffset = WINDOWPLACEMENT_NORMAL_RECT_OFFSET;
    const outerWidth =
      placement.readInt32LE(rectOffset + 8) - placement.readInt32LE(rectOffset);
    const outerHeight =
      placement.readInt32LE(rectOffset + 12) -
      placement.readInt32LE(rectOffset + 4);
    const { exStyle } = this.windowStyles(window);
    const frame = this.outerSizeFor(
      0,
      0,
      dpi,
      style,
      exStyle,
      user.symbols.GetMenu(window) !== 0n,
    );
    return {
      width: ((outerWidth - frame.width) * DEFAULT_DPI) / dpi,
      height: ((outerHeight - frame.height) * DEFAULT_DPI) / dpi,
    };
  }

  private resizePlacement(
    window: bigint,
    placement: Buffer,
    size: ClientSize,
    constraints: WindowSizeConstraints,
    dpi: number,
    style = user.symbols.GetWindowLongPtrW(window, GWL_STYLE),
  ) {
    const clamped = clampWindowSize(size.width, size.height, constraints);
    const { exStyle } = this.windowStyles(window);
    const outerSize = this.outerSizeFor(
      clamped.width,
      clamped.height,
      dpi,
      style,
      exStyle,
      user.symbols.GetMenu(window) !== 0n,
    );
    const rectOffset = WINDOWPLACEMENT_NORMAL_RECT_OFFSET;
    const left = placement.readInt32LE(rectOffset);
    const top = placement.readInt32LE(rectOffset + 4);
    placement.writeInt32LE(left + outerSize.width, rectOffset + 8);
    placement.writeInt32LE(top + outerSize.height, rectOffset + 12);
  }

  private applyMinMaxInfo(window: bigint, lparam: bigint) {
    const initialSize = this.initialOuterSizes.get(window);
    if (initialSize) {
      // The placement plan already includes content constraints and overflow
      // fitting. Pin only this synchronous resize, then restore normal tracking.
      const info = new DataView(
        toArrayBuffer(callbackPointer(lparam), 0, MINMAXINFO_SIZE),
      );
      info.setInt32(24, initialSize.width, true);
      info.setInt32(28, initialSize.height, true);
      info.setInt32(32, initialSize.width, true);
      info.setInt32(36, initialSize.height, true);
      return;
    }
    if (this.fullscreen.has(window)) {
      return;
    }
    const constraints =
      this.constraints.get(window) ?? this.creatingConstraints;
    if (
      !constraints ||
      (constraints.minWidth === null &&
        constraints.minHeight === null &&
        constraints.maxWidth === null &&
        constraints.maxHeight === null)
    ) {
      return;
    }
    const dpi =
      this.dpiByWindow.get(window) ||
      user.symbols.GetDpiForWindow(window) ||
      DEFAULT_DPI;
    const { style, exStyle } = this.windowStyles(window);
    const minimum = this.outerSizeFor(
      constraints.minWidth ?? 0,
      constraints.minHeight ?? 0,
      dpi,
      style,
      exStyle,
      user.symbols.GetMenu(window) !== 0n,
    );
    const maximum = this.outerSizeFor(
      constraints.maxWidth ?? 0,
      constraints.maxHeight ?? 0,
      dpi,
      style,
      exStyle,
      user.symbols.GetMenu(window) !== 0n,
    );
    const info = new DataView(
      toArrayBuffer(callbackPointer(lparam), 0, MINMAXINFO_SIZE),
    );
    if (constraints.minWidth !== null) {
      info.setInt32(24, Math.max(info.getInt32(24, true), minimum.width), true);
    }
    if (constraints.minHeight !== null) {
      info.setInt32(
        28,
        Math.max(info.getInt32(28, true), minimum.height),
        true,
      );
    }
    if (constraints.maxWidth !== null) {
      info.setInt32(32, Math.min(info.getInt32(32, true), maximum.width), true);
    }
    if (constraints.maxHeight !== null) {
      info.setInt32(
        36,
        Math.min(info.getInt32(36, true), maximum.height),
        true,
      );
    }
    // Leave ptMaxSize/ptMaxPosition at their defaults so Windows adjusts them
    // for the target monitor. Clamp the resulting WINDOWPOS instead.
  }

  /**
   * Keep the client ratio while the user drags a border. Maximize, fullscreen
   * and snap layouts do not send WM_SIZING, so they are not forced to the ratio.
   * Returns true when the RECT behind lparam was rewritten.
   */
  private applySizingAspectRatio(
    window: bigint,
    wparam: bigint,
    lparam: bigint,
  ): boolean {
    const ratio = this.aspectRatios.get(window);
    if (ratio === undefined || this.fullscreen.has(window)) {
      return false;
    }
    const view = new DataView(
      toArrayBuffer(callbackPointer(lparam), 0, RECT_SIZE),
    );
    const dpi = this.getDpi(window);
    const { style, exStyle } = this.windowStyles(window);
    const frame = this.outerSizeFor(
      0,
      0,
      dpi,
      style,
      exStyle,
      user.symbols.GetMenu(window) !== 0n,
    );
    const adjusted = adjustSizingRect(
      {
        left: view.getInt32(0, true),
        top: view.getInt32(4, true),
        right: view.getInt32(8, true),
        bottom: view.getInt32(12, true),
      },
      Number(wparam),
      ratio,
      frame,
      dpi,
      this.getSizeConstraints(window),
      systemTrackSize(
        style,
        {
          minWidth: user.symbols.GetSystemMetricsForDpi(SM_CXMINTRACK, dpi),
          minHeight: user.symbols.GetSystemMetricsForDpi(SM_CYMINTRACK, dpi),
          maxWidth: user.symbols.GetSystemMetricsForDpi(SM_CXMAXTRACK, dpi),
          maxHeight: user.symbols.GetSystemMetricsForDpi(SM_CYMAXTRACK, dpi),
        },
        frame,
      ),
    );
    view.setInt32(0, adjusted.left, true);
    view.setInt32(4, adjusted.top, true);
    view.setInt32(8, adjusted.right, true);
    view.setInt32(12, adjusted.bottom, true);
    return true;
  }

  /**
   * Lock user resizing to a content width / height ratio, or release it with
   * null. The current size is left unchanged until the next user resize.
   */
  setAspectRatio(window: bigint, ratio: number | null): void {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    assert(isWindowAspectRatio(ratio), "Invalid window aspect ratio.");
    if (ratio === null) {
      this.aspectRatios.delete(window);
    } else {
      this.aspectRatios.set(window, ratio);
    }
  }

  getAspectRatio(window: bigint): number | null {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    return this.aspectRatios.get(window) ?? null;
  }

  private constrainMaximizedSize(window: bigint, lparam: bigint) {
    const constraints =
      this.constraints.get(window) ?? this.creatingConstraints;
    if (
      !constraints ||
      this.fullscreen.has(window) ||
      !user.symbols.IsZoomed(window)
    ) {
      return;
    }
    const position = new DataView(
      toArrayBuffer(callbackPointer(lparam), 0, WINDOWPOS_SIZE),
    );
    if (position.getUint32(32, true) & SWP_NOSIZE) {
      return;
    }
    const dpi = this.getDpi(window);
    const { style, exStyle } = this.windowStyles(window);
    const frame = this.outerSizeFor(
      0,
      0,
      dpi,
      style,
      exStyle,
      user.symbols.GetMenu(window) !== 0n,
    );
    const size = constrainedOuterSize(
      position.getInt32(24, true),
      position.getInt32(28, true),
      dpi,
      frame,
      constraints,
    );
    position.setInt32(24, size.width, true);
    position.setInt32(28, size.height, true);
  }

  private applyDpiChange(window: bigint, wparam: bigint, lparam: bigint) {
    const dpi = Number(wparam & 0xffffn);
    assert(dpi, "WM_DPICHANGED supplied an invalid DPI.");
    const previousDpi = this.dpiByWindow.get(window) ?? this.readDpi(window);
    // Initial placement owns size and position. Accept the DPI, but do not apply the
    // OS suggestion recursively; its caller recomputes both at the committed DPI.
    if (this.initialOuterSizes.has(window)) {
      this.dpiByWindow.set(window, dpi);
      return;
    }
    const suggested = new DataView(
      toArrayBuffer(callbackPointer(lparam), 0, RECT_SIZE),
    );
    const left = suggested.getInt32(0, true);
    const top = suggested.getInt32(4, true);
    const suggestedWidth = suggested.getInt32(8, true) - left;
    const suggestedHeight = suggested.getInt32(12, true) - top;
    // Publish target DPI before adjusting bounds; size helpers read this cache.
    this.dpiByWindow.set(window, dpi);

    const fullscreen = this.fullscreen.has(window);
    const wasVisible = user.symbols.IsWindowVisible(window) !== 0;
    if (fullscreen) {
      // The suggested position identifies the target monitor before the move
      // is committed. Its scaled size is not the physical fullscreen bounds.
      const bounds = this.monitorBounds(
        user.symbols.MonitorFromRect(
          callbackPointer(lparam),
          MONITOR_DEFAULTTONEAREST,
        ),
      );
      assert(
        user.symbols.SetWindowPos(
          window,
          0n,
          bounds.x,
          bounds.y,
          bounds.width,
          bounds.height,
          SWP_NOZORDER | SWP_NOACTIVATE,
        ),
      );
      if (!wasVisible) {
        user.symbols.ShowWindow(window, SW_HIDE);
      }
      return;
    }
    const constraints = this.constraints.get(window) ?? resolvedConstraints();
    const minimized = !!user.symbols.IsIconic(window);
    const maximized = !!user.symbols.IsZoomed(window);
    // Measure saved normal placement at the old DPI before rescaling it.
    if (minimized) {
      const placement = this.getPlacement(window);
      this.resizePlacement(
        window,
        placement,
        this.clientSizeFromPlacement(window, placement, previousDpi),
        constraints,
        dpi,
      );
      this.setPlacement(window, placement, wasVisible);
      return;
    }
    // Windows can rewrite normal placement while resizing a hidden maximized HWND.
    // Capture its restoration rectangle before applying the DPI suggestion.
    const maximizedPlacement = maximized
      ? this.getPlacement(window)
      : undefined;
    assert(
      user.symbols.SetWindowPos(
        window,
        0n,
        left,
        top,
        suggestedWidth,
        suggestedHeight,
        SWP_NOZORDER | SWP_NOACTIVATE,
      ),
    );
    if (maximizedPlacement) {
      const placement = maximizedPlacement;
      this.resizePlacement(
        window,
        placement,
        this.clientSizeFromPlacement(window, placement, previousDpi),
        constraints,
        dpi,
      );
      this.setPlacement(window, placement, wasVisible, true);
      return;
    }
    const current = this.clientSizeInDips(window, dpi);
    const clamped = clampWindowSize(current.width, current.height, constraints);
    if (clamped.width !== current.width || clamped.height !== current.height) {
      this.setClientSize(window, clamped, dpi);
    }
    if (!wasVisible) {
      user.symbols.ShowWindow(window, SW_HIDE);
    }
  }

  setPosition(window: bigint, x: number, y: number) {
    assert(
      user.symbols.SetWindowPos(
        window,
        0n,
        x,
        y,
        0,
        0,
        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
      ),
    );
  }

  /**
   * Center physical outer bounds in one monitor work area; iconic/zoomed HWNDs keep their
   * display state and only their normal restoration bounds move.
   *
   * Without `monitorId` the area belongs to the monitor nearest the normal bounds. With one,
   * the public monitor ID is resolved against the monitors connected right now, before any
   * geometry changes, so an unknown ID throws INVALID_ARGUMENT and leaves the window
   * untouched instead of falling back to another monitor. Monitor enumeration failures are
   * INTERNAL.
   *
   * For a normal window, the outer size is measured again after placement. If a DPI change
   * altered it, the window is centered once more in the same work area with the new size. If
   * that second placement changes the size again, the result follows the existing DPI
   * handling and may not be exactly centered, so callers verify with the outer bounds.
   *
   * While minimized or maximized, the normal restore bounds are placed and, if their measured
   * size changed, placed once more the same way. When the target monitor has another DPI,
   * where a maximized window ends up and the restored size and position follow Windows' DPI
   * handling; this has not been verified on real multiple monitors.
   */
  center(window: bigint, monitorId?: string): void {
    const editsNormalBounds =
      this.isMinimized(window) || this.isMaximized(window);
    const bounds = this.getBounds(
      window,
      editsNormalBounds ? "normal" : "outer",
    );
    const area =
      monitorId === undefined
        ? this.getWorkArea(this.getPlacementMonitor(undefined, window))
        : selectMonitorWorkArea(monitorServices.list(), monitorId);
    this.setGeometry(
      window,
      "outer",
      centerInWorkArea(area, bounds.width, bounds.height),
    );
    const placed = this.getBounds(
      window,
      editsNormalBounds ? "normal" : "outer",
    );
    if (placed.width !== bounds.width || placed.height !== bounds.height) {
      this.setGeometry(
        window,
        "outer",
        centerInWorkArea(area, placed.width, placed.height),
      );
    }
  }

  /**
   * Apply one geometry request at the current DPI. Validate the full normal rectangle
   * before touching Win32, preserving hidden/iconic/zoomed state and input focus.
   * Synchronous native messages publish only the final current-bounds observation.
   */
  setGeometry(
    window: bigint,
    area: "content" | "outer",
    geometry: GeometryRequest,
  ) {
    if (this.isFullscreen(window)) {
      invalidGeometry("Exit fullscreen before changing window geometry.");
    }
    const dpi = this.getDpi(window);
    const editsNormalBounds =
      this.isMinimized(window) || this.isMaximized(window);
    const current = this.getBounds(
      window,
      editsNormalBounds ? "normal" : "outer",
    );
    const { style, exStyle } = this.windowStyles(window);
    const frame = this.normalWindowFrame(window, style, exStyle, dpi);
    let { x, y, width, height } = current;
    if ("width" in geometry) {
      ({ width, height } = this.requestedOuterSize(
        window,
        area,
        geometry,
        frame,
        dpi,
      ));
    }
    if ("x" in geometry) {
      ({ x, y } = this.requestedOrigin(
        window,
        area,
        geometry,
        frame,
        current,
        editsNormalBounds,
      ));
    }
    assertRectangleFits({
      x,
      y,
      width,
      height,
    });
    const normal = editsNormalBounds
      ? this.prepareNormalPlacement(window, exStyle, {
          x,
          y,
          width,
          height,
        })
      : undefined;
    this.changingGeometry.add(window);
    try {
      if (normal) {
        this.setPlacement(window, normal.placement);
        this.normalMonitors.set(window, normal.monitor);
      } else {
        this.moveResizeWindow(
          window,
          area,
          geometry,
          {
            x,
            y,
            width,
            height,
          },
          dpi,
        );
      }
    } finally {
      this.changingGeometry.delete(window);
      this.observeChanges(window);
    }
  }

  /** Frame offsets and size of the window as it will look when restored to normal. */
  private normalWindowFrame(
    window: bigint,
    style: bigint,
    exStyle: bigint,
    dpi: number,
  ) {
    // Minimized/maximized frame offsets are not those of the future normal window.
    const rect = new Int32Array(4);
    assert(
      user.symbols.AdjustWindowRectExForDpi(
        ptr(rect),
        Number(style & ~WS_MAXIMIZE & ~WS_MINIMIZE),
        user.symbols.GetMenu(window) !== 0n ? 1 : 0,
        Number(exStyle),
        dpi,
      ),
    );
    return {
      left: rect[0] ?? 0,
      top: rect[1] ?? 0,
      width: (rect[2] ?? 0) - (rect[0] ?? 0),
      height: (rect[3] ?? 0) - (rect[1] ?? 0),
    };
  }

  /**
   * Outer size for a size request: reject content sizes outside the public range, then
   * clamp to the window's current size constraints.
   */
  private requestedOuterSize(
    window: bigint,
    area: "content" | "outer",
    geometry: ClientSize,
    frame: ClientSize,
    dpi: number,
  ) {
    const outerWidth = geometry.width + (area === "content" ? frame.width : 0);
    const outerHeight =
      geometry.height + (area === "content" ? frame.height : 0);
    const contentWidth = logicalPixels(outerWidth - frame.width, dpi);
    const contentHeight = logicalPixels(outerHeight - frame.height, dpi);
    if (
      contentWidth < MIN_WINDOW_DIMENSION ||
      contentWidth > MAX_WINDOW_DIMENSION ||
      contentHeight < MIN_WINDOW_DIMENSION ||
      contentHeight > MAX_WINDOW_DIMENSION
    ) {
      invalidGeometry(
        "Requested content size must be 200..4096 logical pixels before constraints.",
      );
    }
    const { width, height } = constrainedOuterSize(
      outerWidth,
      outerHeight,
      dpi,
      {
        width: frame.width,
        height: frame.height,
      },
      this.getSizeConstraints(window),
    );
    return {
      width,
      height,
    };
  }

  /** Outer origin for a position request, converting a content origin by the frame offset. */
  private requestedOrigin(
    window: bigint,
    area: "content" | "outer",
    geometry: {
      x: number;
      y: number;
    },
    frame: {
      left: number;
      top: number;
    },
    current: {
      x: number;
      y: number;
    },
    editsNormalBounds: boolean,
  ) {
    let offsetX = frame.left;
    let offsetY = frame.top;
    if (area === "content" && !editsNormalBounds) {
      const content = this.getBounds(window, "content");
      offsetX = current.x - content.x;
      offsetY = current.y - content.y;
    }
    return {
      x: geometry.x + (area === "content" ? offsetX : 0),
      y: geometry.y + (area === "content" ? offsetY : 0),
    };
  }

  /**
   * Write the requested normal rectangle into the window placement and find the monitor
   * it targets. The rectangle is validated again after the workspace conversion.
   */
  private prepareNormalPlacement(
    window: bigint,
    exStyle: bigint,
    requested: Rectangle,
  ) {
    const placement = this.getPlacement(window);
    const requestedRect = new Int32Array([
      requested.x,
      requested.y,
      requested.x + requested.width,
      requested.y + requested.height,
    ]);
    const display = user.symbols.MonitorFromRect(
      ptr(requestedRect),
      MONITOR_DEFAULTTONEAREST,
    );
    const info = Buffer.alloc(MONITORINFO_SIZE);
    info.writeUInt32LE(MONITORINFO_SIZE);
    assert(display && user.symbols.GetMonitorInfoW(display, ptr(info)));
    let { x, y } = requested;
    if (!(exStyle & WS_EX_TOOLWINDOW)) {
      // Inverse of getNormalBounds: WINDOWPLACEMENT uses destination workspace coordinates.
      x -= info.readInt32LE(20) - info.readInt32LE(4);
      y -= info.readInt32LE(24) - info.readInt32LE(8);
    }
    assertRectangleFits({
      ...requested,
      x,
      y,
    });
    const rect = placement.subarray(WINDOWPLACEMENT_NORMAL_RECT_OFFSET);
    rect.writeInt32LE(x, 0);
    rect.writeInt32LE(y, 4);
    rect.writeInt32LE(x + requested.width, 8);
    rect.writeInt32LE(y + requested.height, 12);
    return {
      placement,
      monitor: {
        display,
        screenRect: info.subarray(4, 4 + RECT_SIZE),
      },
    };
  }

  /**
   * Move and resize a window in its current show state. A content size request on a window
   * with a menu bar is re-applied through the client rectangle, because the bar can wrap
   * at the new width and change the frame height.
   */
  private moveResizeWindow(
    window: bigint,
    area: "content" | "outer",
    geometry: GeometryRequest,
    outer: Rectangle,
    dpi: number,
  ) {
    assert(
      user.symbols.SetWindowPos(
        window,
        0n,
        outer.x,
        outer.y,
        outer.width,
        outer.height,
        SWP_NOZORDER |
          SWP_NOACTIVATE |
          ("x" in geometry ? 0 : SWP_NOMOVE) |
          ("width" in geometry ? 0 : SWP_NOSIZE),
      ),
    );
    if (
      area !== "content" ||
      !("width" in geometry) ||
      !user.symbols.GetMenu(window)
    ) {
      return;
    }
    this.setClientSize(
      window,
      clampWindowSize(
        logicalPixels(geometry.width, dpi),
        logicalPixels(geometry.height, dpi),
        this.getSizeConstraints(window),
      ),
      dpi,
    );
    if ("x" in geometry) {
      const content = this.getBounds(window, "content");
      const outerNow = this.getBounds(window, "outer");
      assert(
        user.symbols.SetWindowPos(
          window,
          0n,
          outerNow.x + geometry.x - content.x,
          outerNow.y + geometry.y - content.y,
          0,
          0,
          SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        ),
      );
    }
  }

  isFullscreen(window: bigint) {
    assert(user.symbols.IsWindow(window), "Window is no longer valid.");
    return this.fullscreen.has(window);
  }

  private monitorBounds(display: bigint) {
    const monitor = Buffer.alloc(MONITORINFO_SIZE);
    monitor.writeUInt32LE(MONITORINFO_SIZE);
    assert(user.symbols.GetMonitorInfoW(display, ptr(monitor)));
    const x = monitor.readInt32LE(4);
    const y = monitor.readInt32LE(8);
    return {
      x,
      y,
      width: monitor.readInt32LE(12) - x,
      height: monitor.readInt32LE(16) - y,
    };
  }

  /**
   * Save normal style and placement, restoring both under current size limits.
   */
  setFullscreen(window: bigint, enabled: boolean) {
    // Style and placement changes produce synchronous intermediate native messages.
    this.changingGeometry.add(window);
    try {
      this.applyFullscreen(window, enabled);
    } finally {
      this.changingGeometry.delete(window);
      this.observeChanges(window);
    }
  }

  private applyFullscreen(window: bigint, enabled: boolean) {
    if (enabled === this.isFullscreen(window)) {
      return;
    }
    if (enabled) {
      if (!this.isFullscreenable(window)) {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "The window is not fullscreenable.",
        });
      }
      const placement = this.getPlacement(window);
      const style = user.symbols.GetWindowLongPtrW(window, GWL_STYLE);
      const dpi = this.getDpi(window);
      const restoreSize = this.clientSizeFromPlacement(
        window,
        placement,
        dpi,
        style,
      );
      const visible = user.symbols.IsWindowVisible(window) !== 0;
      const monitor = user.symbols.MonitorFromWindow(
        window,
        MONITOR_DEFAULTTONEAREST,
      );
      const bounds = this.monitorBounds(monitor);
      this.setStyle(window, style & ~BigInt(WS_OVERLAPPEDWINDOW));
      this.fullscreen.set(window, {
        style,
        placement,
        dpi,
        restoreSize,
        visible,
      });
      try {
        assert(
          user.symbols.SetWindowPos(
            window,
            0n,
            bounds.x,
            bounds.y,
            bounds.width,
            bounds.height,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
          ),
        );
      } catch (error) {
        this.fullscreen.delete(window);
        this.setStyle(window, style);
        throw error;
      }
    } else {
      const saved = this.fullscreen.get(window);
      assert(saved);
      const visible = saved.initial ? this.isVisible(window) : saved.visible;
      this.setStyle(window, saved.style);
      try {
        // Recalculate the restored frame before committing normal placement. The
        // frame update can otherwise rewrite that placement or reshow an iconic HWND.
        // Retain fullscreen suppression until its intermediate bounds are discarded.
        assert(
          user.symbols.SetWindowPos(
            window,
            0n,
            0,
            0,
            0,
            0,
            SWP_NOSIZE |
              SWP_NOMOVE |
              SWP_NOZORDER |
              SWP_NOACTIVATE |
              SWP_FRAMECHANGED,
          ),
        );
        this.fullscreen.delete(window);
        const dpi = this.readDpi(window);
        this.dpiByWindow.set(window, dpi);
        this.resizePlacement(
          window,
          saved.placement,
          saved.restoreSize,
          this.getSizeConstraints(window),
          dpi,
          saved.style,
        );
        this.setPlacement(window, saved.placement, visible, true);
        if (this.closeControls.has(window)) {
          this.applyCloseButton(window);
        }
      } catch (error) {
        this.fullscreen.set(window, saved);
        throw error;
      }
    }
  }

  confirmClose(window: bigint, title: string, message: string): boolean {
    // shortcut: an open MessageBox defers queued destroy; use cancellable confirmation if immediate interruption is required.
    const result = withWide(title, (caption) =>
      withWide(message, (text) =>
        user.symbols.MessageBoxW(
          window,
          text,
          caption,
          MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2,
        ),
      ),
    );
    assert(result, `MessageBoxW: ${kernel.symbols.GetLastError()}`);
    return result === IDYES;
  }

  /** Destroy the HWND and discard its size, DPI, and fullscreen state. */
  destroy(window: bigint) {
    if (this.lastActiveWindow === window) {
      this.lastActiveWindow = null;
    }
    this.observations.delete(window);
    this.changingGeometry.delete(window);
    this.closeControls.delete(window);
    this.nonFullscreenable.delete(window);
    this.interactiveGeometry.delete(window);
    this.immovable.delete(window);
    this.aspectRatios.delete(window);
    try {
      this.accessibleTitles.forget(window);
    } catch (error) {
      // Annotation cleanup is best effort; a failure must not block destroy, and the cache entry is already dropped.
      console.error(
        "Could not clear the accessible title before destroy.",
        error,
      );
    }
    assert(user.symbols.DestroyWindow(window));
    this.taskbar.forget(window);
    this.windows.delete(window);
    this.constraints.delete(window);
    this.dpiByWindow.delete(window);
    this.normalMonitors.delete(window);
    this.fullscreen.delete(window);
  }

  /** Dispatch a bounded message batch and surface any callback failure. */
  pump() {
    for (
      let count = 0;
      count < MAX_MESSAGES_PER_PUMP &&
      user.symbols.PeekMessageW(ptr(this.message), 0n, 0, 0, PM_REMOVE);
      count++
    ) {
      if (this.message.readUInt32LE(8) === WM_QUIT) {
        throw new Error("Unexpected WM_QUIT");
      }
      user.symbols.TranslateMessage(ptr(this.message));
      user.symbols.DispatchMessageW(ptr(this.message));
    }
    if (this.failure) {
      throw this.failure;
    }
  }

  private releaseIcons() {
    if (this.ownedIcons) {
      if (this.icon) {
        user.symbols.DestroyIcon(this.icon);
      }
      if (this.smallIcon) {
        user.symbols.DestroyIcon(this.smallIcon);
      }
    }
  }

  /**
   * Release the class, callback, icons, and thread DPI context.
   * Call after all windows have been destroyed.
   */
  dispose() {
    // Release before the live-window assertion so a failed destroy cannot leak the icon handles.
    this.taskbar.releaseIcons();
    assert.equal(this.windows.size, 0);
    this.taskbar.dispose();
    this.accessibleTitles.dispose();
    if (this.registered) {
      assert(user.symbols.UnregisterClassW(ptr(this.name), this.instance));
    }
    this.registered = false;
    this.callback.close();
    this.releaseIcons();
    assert(
      user.symbols.SetThreadDpiAwarenessContext(
        this.previousDpiAwarenessContext,
      ),
      `SetThreadDpiAwarenessContext: ${kernel.symbols.GetLastError()}`,
    );
  }

  /** Apply progress to a live HWND without changing visibility, activation or window state. */
  setTaskbarProgress(window: bigint, progress: TaskbarProgress): void {
    assert(this.windows.has(window), "Taskbar target is not a live window");
    this.taskbar.setProgress(window, progress);
  }

  /** Clip the taskbar thumbnail to a client-area region in logical pixels, or clear it for null. */
  setThumbnailClip(window: bigint, region: ThumbnailClip): void {
    assert(this.windows.has(window), "Taskbar target is not a live window");
    this.taskbar.setThumbnailClip(window, region);
  }

  /** Set the taskbar thumbnail tooltip, or restore the window title for null or an empty string. */
  setThumbnailToolTip(window: bigint, toolTip: string | null): void {
    assert(this.windows.has(window), "Taskbar target is not a live window");
    this.taskbar.setThumbnailToolTip(window, toolTip);
  }

  /** Show the overlay icon with an accessibility description on the taskbar button, or remove it for null. */
  setOverlayIcon(
    window: bigint,
    icon: NativeOverlayIconProvider | null,
    description: string,
  ): void {
    assert(this.windows.has(window), "Taskbar target is not a live window");
    this.taskbar.setOverlayIcon(window, icon, description);
  }
}
