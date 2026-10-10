import { dlopen, JSCallback, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import assert from "node:assert/strict";
import {
  clampWindowSize,
  hasValidWindowSizeConstraints,
  type WindowBounds,
  type WindowSizeConstraints,
} from "@bunaway/plugin-api/native";
import {
  APP_SHUTDOWN_MESSAGE,
  APP_WINDOW_CLASS_PREFIX,
} from "@bunaway/runtime-bun/windows-control";
import { hr, kernel, user, wide, withWide } from "./win32-bindings.ts";
import {
  constrainedOuterSize,
  DEFAULT_DPI,
  logicalPixels,
  physicalPixels,
} from "./window-size.ts";

export const WM_SIZE = 0x0005;
export const WM_CLOSE = 0x0010;
export const WM_QUIT = 0x0012;
const WM_GETMINMAXINFO = 0x0024;
const WM_WINDOWPOSCHANGING = 0x0046;
const WM_WINDOWPOSCHANGED = 0x0047;
const WM_DISPLAYCHANGE = 0x007e;
export const WM_ENTERSIZEMOVE = 0x0231;
export const WM_EXITSIZEMOVE = 0x0232;
const WM_DPICHANGED = 0x02e0;

const COLOR_WINDOW = 5;
const CW_USEDEFAULT = -2147483648;
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4n;
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x80n;
const IDI_APPLICATION = 32512n;
const IMAGE_ICON = 1;
const LR_LOADFROMFILE = 0x10;
const MB_DEFBUTTON2 = 0x100;
const MB_ICONQUESTION = 0x20;
const MB_YESNO = 0x4;
const MONITOR_DEFAULTTONEAREST = 2;
const PM_REMOVE = 1;
const SM_CXSIZEFRAME = 32;
const SM_CYSIZEFRAME = 33;
const SM_CXPADDEDBORDER = 92;
const SW_HIDE = 0;
const SW_SHOWNORMAL = 1;
const SW_MINIMIZE = 6;
const SW_RESTORE = 9;
const SW_SHOW = 5;
const SW_SHOWMAXIMIZED = 3;
const SW_SHOWNA = 8;
const SWP_FRAMECHANGED = 0x20;
const SWP_NOMOVE = 0x2;
const SWP_NOACTIVATE = 0x10;
const SWP_NOSIZE = 0x1;
const SWP_NOZORDER = 0x4;
const WINDOWPLACEMENT_NORMAL_RECT_OFFSET = 28;
const WINDOWPLACEMENT_FLAGS_OFFSET = 4;
const WINDOWPLACEMENT_SHOW_CMD_OFFSET = 8;
const WPF_RESTORETOMAXIMIZED = 0x2;
const WS_OVERLAPPEDWINDOW = 0x00cf0000;
const IDYES = 6;
const MAX_MESSAGES_PER_PUMP = 64;
const MINMAXINFO_SIZE = 40;
const MONITORINFO_SIZE = 40;
const RECT_SIZE = 16;
const WINDOWPLACEMENT_SIZE = 44;
const WINDOWPOS_SIZE = 40;

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

// One class and one bounded pump per STA, shared by every view.
export class Windows {
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
    }
  >();
  private registered = false;
  failure: unknown;
  readonly icon: bigint;
  private readonly smallIcon: bigint;
  private readonly ownedIcons: boolean;

  /** Register the window class and set this STA to per-monitor-v2 awareness. */
  constructor(shutdown: () => void, iconPath?: string, appId?: string) {
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
        hr(
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
          if (message === APP_SHUTDOWN_MESSAGE) {
            shutdown();
            return 0n;
          }
          if (message === WM_GETMINMAXINFO) {
            user.symbols.DefWindowProcW(window, message, wparam, lparam);
            this.applyMinMaxInfo(window, lparam);
            this.windows.get(window)?.(message, wparam, lparam);
            return 0n;
          }
          if (message === WM_DPICHANGED) {
            this.applyDpiChange(window, wparam, lparam);
            this.windows.get(window)?.(message, wparam, lparam);
            return 0n;
          }
          if (message === WM_WINDOWPOSCHANGING) {
            this.constrainMaximizedSize(window, lparam);
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
          if (message === WM_WINDOWPOSCHANGED && this.windows.has(window)) {
            this.rememberNormalMonitor(window);
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

  /**
   * Create a window with a clamped logical client size.
   * Register its state before showing it.
   */
  create(
    title: string,
    width: number,
    height: number,
    receive: (message: number, wparam: bigint, lparam: bigint) => void,
    visible = true,
    constraints: SizeConstraints = {},
  ) {
    const initialConstraints = resolvedConstraints(constraints);
    const initialSize = clampWindowSize(width, height, initialConstraints);
    const outerSize = this.outerSizeFor(
      initialSize.width,
      initialSize.height,
      DEFAULT_DPI,
      BigInt(WS_OVERLAPPEDWINDOW),
      0n,
    );
    // WM_GETMINMAXINFO can run before CreateWindowExW returns the HWND.
    this.creatingConstraints = initialConstraints;
    let window: bigint;
    try {
      window = withWide(title, (titlePointer) =>
        user.symbols.CreateWindowExW(
          0,
          ptr(this.name),
          titlePointer,
          WS_OVERLAPPEDWINDOW,
          CW_USEDEFAULT,
          CW_USEDEFAULT,
          outerSize.width,
          outerSize.height,
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
      this.dpiByWindow.set(window, this.getDpi(window));
      this.setSize(window, initialSize.width, initialSize.height);
      this.rememberNormalMonitor(window);
      if (visible) {
        user.symbols.ShowWindow(window, SW_SHOW);
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
    user.symbols.ShowWindow(window, visible ? SW_SHOW : SW_HIDE);
  }

  focus(window: bigint): boolean {
    user.symbols.ShowWindow(
      window,
      user.symbols.IsIconic(window) ? SW_RESTORE : SW_SHOW,
    );
    return !!user.symbols.SetForegroundWindow(window);
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
    user.symbols.ShowWindow(window, command);
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
    return {
      width: logicalPixels(size.width, dpi),
      height: logicalPixels(size.height, dpi),
    };
  }

  private outerSizeFor(
    width: number,
    height: number,
    dpi: number,
    style: bigint,
    exStyle: bigint,
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
        0,
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

  private setStyle(window: bigint, style: bigint) {
    kernel.symbols.SetLastError(0);
    const previousStyle = user.symbols.SetWindowLongPtrW(
      window,
      GWL_STYLE,
      style,
    );
    const error = kernel.symbols.GetLastError();
    assert(previousStyle !== 0n || error === 0, `SetWindowLongPtrW: ${error}`);
  }

  private setClientSize(window: bigint, size: ClientSize, dpi: number) {
    const { style, exStyle } = this.windowStyles(window);
    const outerSize = this.outerSizeFor(
      size.width,
      size.height,
      dpi,
      style,
      exStyle,
    );
    assert(
      user.symbols.SetWindowPos(
        window,
        0n,
        0,
        0,
        outerSize.width,
        outerSize.height,
        SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
      ),
    );
  }

  private getPlacement(window: bigint) {
    const placement = Buffer.alloc(WINDOWPLACEMENT_SIZE);
    placement.writeUInt32LE(WINDOWPLACEMENT_SIZE);
    assert(user.symbols.GetWindowPlacement(window, ptr(placement)));
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
    const frame = this.outerSizeFor(0, 0, dpi, style, exStyle);
    return {
      width: logicalPixels(outerWidth - frame.width, dpi),
      height: logicalPixels(outerHeight - frame.height, dpi),
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
    );
    const rectOffset = WINDOWPLACEMENT_NORMAL_RECT_OFFSET;
    const left = placement.readInt32LE(rectOffset);
    const top = placement.readInt32LE(rectOffset + 4);
    placement.writeInt32LE(left + outerSize.width, rectOffset + 8);
    placement.writeInt32LE(top + outerSize.height, rectOffset + 12);
  }

  private applyMinMaxInfo(window: bigint, lparam: bigint) {
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
    );
    const maximum = this.outerSizeFor(
      constraints.maxWidth ?? 0,
      constraints.maxHeight ?? 0,
      dpi,
      style,
      exStyle,
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
    const frame = this.outerSizeFor(0, 0, dpi, style, exStyle);
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
    if (maximized) {
      const placement = this.getPlacement(window);
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
    if (enabled === this.isFullscreen(window)) {
      return;
    }
    if (enabled) {
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
      this.setStyle(window, saved.style);
      this.fullscreen.delete(window);
      try {
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
        this.setPlacement(window, saved.placement, saved.visible, true);
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
      } catch (error) {
        this.fullscreen.set(window, saved);
        throw error;
      }
    }
  }

  confirmClose(window: bigint, title: string, message: string): boolean {
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
    assert(user.symbols.DestroyWindow(window));
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
    assert.equal(this.windows.size, 0);
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
}
