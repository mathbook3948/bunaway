import {
  hasValidWindowSizeConstraints,
  type NativeWindow,
  type NativeWindowServices,
  type WindowAttentionMode,
  type WindowIdentity,
  type WindowSizeConstraints,
} from "@bunaway/plugin-api/native";
import { BunawayError, type JsonValue } from "@bunaway/protocol";
import type { WindowCall } from "#windows/contract";
import { convertGeometry } from "#windows/platforms/window-geometry";
import { overlayIconProvider } from "#windows/platforms/windows-overlay-icon";

/** Flash mode applied when `windows.requestAttention` omits `mode`. */
const DEFAULT_ATTENTION_MODE: WindowAttentionMode = "untilFocused";

/** Services a window action needs beyond the target window itself. */
export type WindowActionContext = {
  services: NativeWindowServices;
  /** Whether a native instance key is being recreated, so its identity is not yet usable. */
  isReplacing(key: string): boolean;
  /** Resolve an identity to the logical key the services use. */
  identityKey(identity: WindowIdentity): string;
};

type ActionScope = WindowActionContext & {
  window: NativeWindow;
  viewId: string;
};

/** Returned by a group that does not handle the operation, so the next group is tried. */
const UNHANDLED = Symbol("unhandled window operation");
type ActionResult = JsonValue | Promise<JsonValue> | typeof UNHANDLED;
type ActionGroup = (scope: ActionScope, call: WindowCall) => ActionResult;

function unsupportedError(message: string): () => BunawayError {
  return () =>
    new BunawayError({
      code: "UNSUPPORTED",
      message,
    });
}

const unsupportedMonitor = unsupportedError("Monitor queries are unavailable.");
const unsupportedPrint = unsupportedError(
  "WebView print dialogs are not implemented on this platform.",
);
const unsupportedDownloads = unsupportedError(
  "WebView downloads are not implemented on this platform.",
);
const unsupportedWebView = unsupportedError(
  "WebView control is not implemented on this platform.",
);
const unsupportedAudio = unsupportedError(
  "WebView audio controls are not implemented on this platform.",
);
const unsupportedClose = unsupportedError(
  "Close requests are not implemented on this platform.",
);
const unsupportedRelations = unsupportedError(
  "Window ownership control is not implemented on this platform.",
);
const unsupportedFocusability = unsupportedError(
  "Window focusability is not implemented on this platform.",
);
const unsupportedFullscreenable = unsupportedError(
  "Fullscreenable is not implemented on this platform.",
);
const unsupportedOpacity = unsupportedError(
  "Window opacity is not implemented on this platform.",
);
const unsupportedMouseEvents = unsupportedError(
  "Ignoring mouse events is not implemented on this platform.",
);
const unsupportedControls = unsupportedError(
  "Native caption controls are not implemented on this platform.",
);
const unsupportedTitle = unsupportedError(
  "Window title control is not implemented on this platform.",
);
const unsupportedDisplay = unsupportedError(
  "Window display options are not implemented on this platform.",
);
const unsupportedAttention = unsupportedError(
  "Window attention requests are not implemented on this platform.",
);
const unsupportedMovement = unsupportedError(
  "Window movement controls are not implemented on this platform.",
);
const unsupportedAspectRatio = unsupportedError(
  "Window aspect ratio locking is not implemented on this platform.",
);
const unsupportedCentering = unsupportedError(
  "Window centering is not implemented on this platform.",
);
const unsupportedTaskbarProgress = unsupportedError(
  "Taskbar progress is not implemented on this platform.",
);
const unsupportedThumbnailClip = unsupportedError(
  "Thumbnail clip is not implemented on this platform.",
);
const unsupportedThumbnailToolTip = unsupportedError(
  "Thumbnail tooltip is not implemented on this platform.",
);
const unsupportedOverlayIcon = unsupportedError(
  "Taskbar overlay icon is not implemented on this platform.",
);

/** Return an optional native control, or throw the platform's UNSUPPORTED error when it is absent. */
function supported<T>(control: T | undefined, unsupported: () => BunawayError) {
  if (control === undefined) {
    throw unsupported();
  }
  return control;
}

/** Reject a state, size or position change while fullscreen; leaving fullscreen stays allowed. */
function rejectInFullscreen(window: NativeWindow, change: string): void {
  if (window.isFullscreen()) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: `Exit fullscreen before ${change}.`,
    });
  }
}

/** Reject size limits whose minimum exceeds the maximum before any bound changes. */
function validSizeConstraints(
  constraints: WindowSizeConstraints,
  message: string,
): WindowSizeConstraints {
  if (!hasValidWindowSizeConstraints(constraints)) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message,
    });
  }
  return constraints;
}

/**
 * Apply a validated, permitted window call to the native window of `viewId`.
 * Each group handles its own operations and returns UNHANDLED for the rest; native failures and
 * missing platform controls throw. Operations without a result return null.
 */
export function applyWindowCall(
  context: WindowActionContext,
  call: WindowCall,
  viewId: string,
): JsonValue | Promise<JsonValue> {
  const scope: ActionScope = {
    ...context,
    window: context.services.window(viewId),
    viewId,
  };
  for (const group of ACTION_GROUPS) {
    const result = group(scope, call);
    if (result !== UNHANDLED) {
      return result;
    }
  }
  throw new BunawayError({
    code: "INVALID_ARGUMENT",
    message: "Expected a window operation.",
  });
}

/** Print dialogs, downloads, WebView navigation and audio. */
function applyWebContent(scope: ActionScope, call: WindowCall): ActionResult {
  const { window } = scope;
  const downloads = () => supported(window.downloads, unsupportedDownloads);
  const webview = () => supported(window.webview, unsupportedWebView);
  const audio = () => supported(window.audio, unsupportedAudio);
  switch (call.operation) {
    case "windows.showPrintUI":
      supported(
        window.showPrintUI,
        unsupportedPrint,
      )(call.payload.kind ?? "browser");
      return null;
    case "windows.setDownloadRequestsEnabled":
      downloads().setRequestsEnabled(call.payload.enabled);
      return null;
    case "windows.getDownloads":
      return downloads()
        .list()
        .map((download) => ({
          ...download,
        }));
    case "windows.approveDownload":
      downloads().approve(call.payload.id);
      return null;
    case "windows.cancelDownload":
      downloads().cancel(call.payload.id);
      return null;
    case "windows.pauseDownload":
      downloads().pause(call.payload.id);
      return null;
    case "windows.resumeDownload":
      downloads().resume(call.payload.id);
      return null;
    case "windows.forgetDownload":
      downloads().forget(call.payload.id);
      return null;
    case "windows.getWebViewState":
      return {
        ...webview().getState(),
      };
    case "windows.navigateWebView":
      webview().navigate(call.payload.url);
      return null;
    case "windows.reloadWebView":
      webview().reload();
      return null;
    case "windows.stopWebView":
      webview().stop();
      return null;
    case "windows.goBack":
      return webview().goBack();
    case "windows.goForward":
      return webview().goForward();
    case "windows.setZoomFactor":
      return webview().setZoomFactor(call.payload.factor);
    case "windows.openDevTools":
      webview().openDevTools();
      return null;
    case "windows.getWebViewAudioState":
      return {
        ...audio().getState(),
      };
    case "windows.setWebViewAudioMuted":
      audio().setMuted(call.payload.muted);
      return null;
    default:
      return UNHANDLED;
  }
}

/** Readiness, visibility, focus, closing and the close confirmation. */
function applyLifecycle(scope: ActionScope, call: WindowCall): ActionResult {
  const { window } = scope;
  switch (call.operation) {
    case "windows.getMonitor":
      return {
        ...supported(window.getMonitor, unsupportedMonitor)(),
      };
    case "windows.getReadiness":
      return {
        ...window.getReadiness(),
      };
    case "windows.completeSplashscreen":
      return completeSplashscreen(scope, call.payload.splash);
    case "windows.getSnapshot":
      return {
        ...window.getSnapshot(),
      };
    case "windows.show":
      window.show(true);
      return null;
    case "windows.showInactive":
      window.showInactive();
      return null;
    case "windows.hide":
      window.show(false);
      return null;
    case "windows.focus":
      if (!window.focus()) {
        throw new BunawayError({
          code: "BUSY",
          message: "OS declined window focus.",
        });
      }
      return null;
    case "windows.activate":
      return window.activate();
    case "windows.blur":
      return blur(scope);
    case "windows.close":
      return window.close();
    case "windows.respondClose":
      supported(window.respondClose, unsupportedClose)(
        call.payload.requestId,
        call.payload.allow,
      );
      return null;
    case "windows.destroy":
      return supported(window.destroy, unsupportedRelations)();
    case "windows.setCloseConfirmation":
      window.setCloseConfirmation(call.payload.message);
      return null;
    default:
      return UNHANDLED;
  }
}

/**
 * Hand the app from a splashscreen to this main window once the main window is ready.
 * Everything is validated before either window changes, because closing an owner also retires
 * its descendants.
 */
function completeSplashscreen(
  scope: ActionScope,
  splash: string,
): boolean | Promise<boolean> {
  const { window, services, viewId } = scope;
  if (viewId === splash) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Splashscreen and main window must differ.",
    });
  }
  const readiness = window.getReadiness();
  if (readiness.document !== "ready" || readiness.sdk !== "ready") {
    throw new BunawayError({
      code: "BUSY",
      message: "Main window is not ready.",
    });
  }
  const splashState = services.read(splash);
  if (!splashState || splashState.closed) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Splashscreen is not open.",
    });
  }
  for (
    let parent = window.getParent?.();
    parent;
    parent = services.window(scope.identityKey(parent)).getParent?.()
  ) {
    if (parent.viewId === splash) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Splashscreen cannot own the main window.",
      });
    }
  }
  // Final handoff preserves confirmation and bypasses quit/hide, without reserving
  // another splash lifetime or retaining its isolated profile.
  window.show(true);
  return services.close(splash, false);
}

/**
 * Give up focus by activating the next ready, visible window in configuration order.
 * Never activates an external window; returns whether this window is no longer focused.
 */
function blur(scope: ActionScope): boolean | Promise<boolean> {
  const { window, services, viewId } = scope;
  if (window.isMinimized() || !window.isVisible()) {
    return !window.isFocused();
  }
  if (!window.isFocused()) {
    return true;
  }
  // Configuration order is deterministic; never activate an external window.
  const instances = services.instances?.();
  const candidates = services.specs.flatMap((spec) =>
    instances
      ? instances
          .filter((entry) => entry.identity.viewId === spec.view)
          .map((entry) => ({
            key: entry.key,
            viewId: spec.view,
          }))
      : [
          {
            key: spec.view,
            viewId: spec.view,
          },
        ],
  );
  for (const candidate of candidates) {
    if (
      candidate.key === viewId ||
      !services.specs.some((spec) => spec.view === candidate.viewId)
    ) {
      continue;
    }
    const state = services.read(candidate.key);
    if (
      !state ||
      state.closed ||
      !state.ready ||
      state.failure ||
      scope.isReplacing(candidate.key)
    ) {
      continue;
    }
    const next = services.window(candidate.key);
    if (
      next.isVisible() &&
      !next.isMinimized() &&
      next.isFocusable?.() !== false
    ) {
      next.activate();
      return !window.isFocused();
    }
  }
  return false;
}

/** Whether another window of a configured view that is not being recreated may be shown to callers. */
function isVisibleIdentity(
  scope: ActionScope,
  identity: WindowIdentity,
): boolean {
  return (
    scope.services.specs.some((spec) => spec.view === identity.viewId) &&
    !scope.isReplacing(scope.identityKey(identity))
  );
}

/** Ownership and input availability. */
function applyRelations(scope: ActionScope, call: WindowCall): ActionResult {
  const { window } = scope;
  switch (call.operation) {
    case "windows.setParent":
      supported(window.setParent, unsupportedRelations)(
        call.payload.parent,
        call.payload.modal,
      );
      return null;
    case "windows.getParent":
    case "windows.getOwner": {
      const parent = supported(window.getParent, unsupportedRelations)();
      return parent && isVisibleIdentity(scope, parent)
        ? {
            ...parent,
          }
        : null;
    }
    case "windows.getChildren":
      return supported(window.getChildren, unsupportedRelations)()
        .filter((child) => isVisibleIdentity(scope, child))
        .map((child) => ({
          ...child,
        }));
    case "windows.setEnabled":
      supported(window.setEnabled, unsupportedRelations)(call.payload.enabled);
      return null;
    case "windows.isEnabled":
      return supported(window.isEnabled, unsupportedRelations)();
    default:
      return UNHANDLED;
  }
}

/** Title bar, z-order, taskbar presence, attention, opacity and titles. */
function applyAppearance(scope: ActionScope, call: WindowCall): ActionResult {
  const { window } = scope;
  switch (call.operation) {
    case "windows.getTitlebar":
      return supported(window.getTitlebar, unsupportedDisplay)();
    case "windows.setAlwaysOnTop":
      supported(
        window.setAlwaysOnTop,
        unsupportedDisplay,
      )(call.payload.alwaysOnTop);
      return null;
    case "windows.isAlwaysOnTop":
      return supported(window.isAlwaysOnTop, unsupportedDisplay)();
    case "windows.setSkipTaskbar":
      supported(
        window.setSkipTaskbar,
        unsupportedDisplay,
      )(call.payload.skipTaskbar);
      return null;
    case "windows.isSkipTaskbar":
      return supported(window.isSkipTaskbar, unsupportedDisplay)();
    case "windows.setContentProtection":
      supported(
        window.setContentProtection,
        unsupportedDisplay,
      )(call.payload.contentProtection);
      return null;
    case "windows.isContentProtected":
      return supported(window.isContentProtected, unsupportedDisplay)();
    case "windows.requestAttention":
      supported(
        window.requestAttention,
        unsupportedAttention,
      )(call.payload.mode ?? DEFAULT_ATTENTION_MODE);
      return null;
    case "windows.cancelAttention":
      supported(window.cancelAttention, unsupportedAttention)();
      return null;
    case "windows.setOpacity":
      supported(window.setOpacity, unsupportedOpacity)(call.payload.opacity);
      return null;
    case "windows.getOpacity":
      return supported(window.getOpacity, unsupportedOpacity)();
    case "windows.setTitle":
      supported(window.setTitle, unsupportedTitle)(call.payload.title);
      return null;
    case "windows.getTitle":
      return supported(window.getTitle, unsupportedTitle)();
    case "windows.setAccessibleTitle":
      supported(
        window.setAccessibleTitle,
        unsupportedTitle,
      )(call.payload.title);
      return null;
    case "windows.getAccessibleTitle":
      return supported(window.getAccessibleTitle, unsupportedTitle)();
    default:
      return UNHANDLED;
  }
}

/** What the user may do to the window: focus, caption buttons, resizing, moving and mouse input. */
function applyUserControls(scope: ActionScope, call: WindowCall): ActionResult {
  const { window } = scope;
  switch (call.operation) {
    case "windows.setFocusable":
      supported(
        window.setFocusable,
        unsupportedFocusability,
      )(call.payload.focusable);
      return null;
    case "windows.isFocusable":
      return supported(window.isFocusable, unsupportedFocusability)();
    case "windows.setMinimizable":
      supported(
        window.setMinimizable,
        unsupportedControls,
      )(call.payload.minimizable);
      return null;
    case "windows.isMinimizable":
      return supported(window.isMinimizable, unsupportedControls)();
    case "windows.setMaximizable":
      supported(
        window.setMaximizable,
        unsupportedControls,
      )(call.payload.maximizable);
      return null;
    case "windows.isMaximizable":
      return supported(window.isMaximizable, unsupportedControls)();
    case "windows.setClosable":
      supported(window.setClosable, unsupportedControls)(call.payload.closable);
      return null;
    case "windows.isClosable":
      return supported(window.isClosable, unsupportedControls)();
    case "windows.setFullscreenable":
      supported(
        window.setFullscreenable,
        unsupportedFullscreenable,
      )(call.payload.fullscreenable);
      return null;
    case "windows.isFullscreenable":
      return supported(window.isFullscreenable, unsupportedFullscreenable)();
    case "windows.setIgnoreMouseEvents":
      supported(
        window.setIgnoreMouseEvents,
        unsupportedMouseEvents,
      )(call.payload.ignore);
      return null;
    case "windows.isIgnoreMouseEvents":
      return supported(window.isIgnoreMouseEvents, unsupportedMouseEvents)();
    case "windows.setResizable":
      supported(
        window.setResizable,
        unsupportedMovement,
      )(call.payload.resizable);
      return null;
    case "windows.isResizable":
      return supported(window.isResizable, unsupportedMovement)();
    case "windows.setMovable":
      supported(window.setMovable, unsupportedMovement)(call.payload.movable);
      return null;
    case "windows.isMovable":
      return supported(window.isMovable, unsupportedMovement)();
    case "windows.setAspectRatio":
      supported(
        window.setAspectRatio,
        unsupportedAspectRatio,
      )(call.payload.ratio);
      return null;
    case "windows.getAspectRatio":
      return supported(window.getAspectRatio, unsupportedAspectRatio)();
    default:
      return UNHANDLED;
  }
}

/** Minimized, maximized and fullscreen state. */
function applyDisplayState(scope: ActionScope, call: WindowCall): ActionResult {
  const { window } = scope;
  switch (call.operation) {
    case "windows.minimize":
      rejectInFullscreen(window, "changing window state");
      window.minimize();
      return null;
    case "windows.maximize":
      rejectInFullscreen(window, "changing window state");
      window.maximize();
      return null;
    case "windows.unmaximize":
      rejectInFullscreen(window, "changing window state");
      window.unmaximize();
      return null;
    case "windows.restore":
      rejectInFullscreen(window, "changing window state");
      window.restore();
      return null;
    case "windows.toggleMaximize":
      rejectInFullscreen(window, "changing window state");
      window.toggleMaximize();
      return null;
    case "windows.isMinimized":
      return window.isMinimized();
    case "windows.isMaximized":
      return window.isMaximized();
    case "windows.isFullscreen":
      return window.isFullscreen();
    case "windows.isVisible":
      return window.isVisible();
    case "windows.isFocused":
      return window.isFocused();
    case "windows.isNormal":
      return (
        !window.isMinimized() && !window.isMaximized() && !window.isFullscreen()
      );
    case "windows.setFullscreen":
      // Leaving is always allowed so a window changed to non-fullscreenable
      // while fullscreen cannot become stuck. Entering is the guarded direction.
      if (call.payload.fullscreen && window.isFullscreenable?.() === false) {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "The window is not fullscreenable.",
        });
      }
      window.setFullscreen(call.payload.fullscreen);
      return null;
    default:
      return UNHANDLED;
  }
}

/** Position, size and DPI conversion. */
function applyGeometry(scope: ActionScope, call: WindowCall): ActionResult {
  const { window } = scope;
  switch (call.operation) {
    case "windows.getContentSize":
    case "windows.getOuterSize":
    case "windows.getContentPosition":
    case "windows.getOuterPosition":
    case "windows.getContentBounds":
    case "windows.getOuterBounds":
    case "windows.getNormalBounds":
      return readBounds(window, call);
    case "windows.toLogical":
    case "windows.toPhysical": {
      const dpi = window.getDpi();
      const unit =
        call.operation === "windows.toLogical" ? "logical" : "physical";
      return {
        value: convertGeometry(call.payload.value, dpi, unit),
        dpi,
      };
    }
    case "windows.setSize":
      rejectInFullscreen(window, "changing size");
      window.setSize(call.payload.width, call.payload.height);
      return null;
    case "windows.setPosition":
      rejectInFullscreen(window, "changing position");
      window.setPosition(call.payload.x, call.payload.y);
      return null;
    case "windows.center":
      rejectInFullscreen(window, "centering the window");
      supported(window.center, unsupportedCentering)(call.payload.monitorId);
      return null;
    case "windows.setContentPosition":
    case "windows.setOuterSize":
    case "windows.setContentBounds":
    case "windows.setOuterBounds": {
      rejectInFullscreen(window, "changing window geometry");
      const { view: _view, unit, ...geometry } = call.payload;
      const physical =
        unit === "logical"
          ? convertGeometry(geometry, window.getDpi(), "physical")
          : geometry;
      window.setGeometry(
        call.operation.startsWith("windows.setContent") ? "content" : "outer",
        physical,
      );
      return null;
    }
    default:
      return UNHANDLED;
  }
}

/** Read bounds in the requested unit, then reduce them to the size, position or full rectangle asked for. */
function readBounds(
  window: NativeWindow,
  call: Extract<
    WindowCall,
    {
      operation:
        | "windows.getContentSize"
        | "windows.getOuterSize"
        | "windows.getContentPosition"
        | "windows.getOuterPosition"
        | "windows.getContentBounds"
        | "windows.getOuterBounds"
        | "windows.getNormalBounds";
    }
  >,
): JsonValue {
  let area: "content" | "outer" | "normal" = "outer";
  if (call.operation.startsWith("windows.getContent")) {
    area = "content";
  }
  if (call.operation === "windows.getNormalBounds") {
    area = "normal";
  }
  const { dpi, ...physical } = window.getBounds(area);
  const bounds =
    call.payload.unit === "logical"
      ? convertGeometry(physical, dpi, "logical")
      : physical;
  if (call.operation.endsWith("Size") && "width" in bounds) {
    return {
      width: bounds.width,
      height: bounds.height,
      dpi,
    };
  }
  if (call.operation.endsWith("Position") && "x" in bounds) {
    return {
      x: bounds.x,
      y: bounds.y,
      dpi,
    };
  }
  return {
    ...bounds,
    dpi,
  };
}

/** Minimum and maximum resize limits. */
function applySizeLimits(scope: ActionScope, call: WindowCall): ActionResult {
  const { window } = scope;
  switch (call.operation) {
    case "windows.getMinSize": {
      const constraints = window.getSizeConstraints();
      return {
        width: constraints.minWidth,
        height: constraints.minHeight,
      };
    }
    case "windows.getMaxSize": {
      const constraints = window.getSizeConstraints();
      return {
        width: constraints.maxWidth,
        height: constraints.maxHeight,
      };
    }
    case "windows.setMinSize":
      window.setSizeConstraints(
        validSizeConstraints(
          {
            ...window.getSizeConstraints(),
            minWidth: call.payload.width,
            minHeight: call.payload.height,
          },
          "Minimum window size cannot exceed the maximum size.",
        ),
      );
      return null;
    case "windows.setMaxSize":
      window.setSizeConstraints(
        validSizeConstraints(
          {
            ...window.getSizeConstraints(),
            maxWidth: call.payload.width,
            maxHeight: call.payload.height,
          },
          "Maximum window size cannot be smaller than the minimum size.",
        ),
      );
      return null;
    case "windows.getSizeConstraints":
      return {
        ...window.getSizeConstraints(),
      };
    case "windows.setSizeConstraints":
      // Omitted bounds mean no limit; validate the complete pair before changing either bound.
      window.setSizeConstraints(
        validSizeConstraints(
          {
            minWidth: call.payload.minWidth ?? null,
            minHeight: call.payload.minHeight ?? null,
            maxWidth: call.payload.maxWidth ?? null,
            maxHeight: call.payload.maxHeight ?? null,
          },
          "Minimum window size cannot exceed the maximum size.",
        ),
      );
      return null;
    default:
      return UNHANDLED;
  }
}

/** Taskbar progress, thumbnail and overlay icon. */
function applyTaskbar(scope: ActionScope, call: WindowCall): ActionResult {
  const { window } = scope;
  switch (call.operation) {
    case "windows.setTaskbarProgress":
      supported(
        window.setTaskbarProgress,
        unsupportedTaskbarProgress,
      )(call.payload);
      return null;
    case "windows.setThumbnailClip":
      supported(
        window.setThumbnailClip,
        unsupportedThumbnailClip,
      )(call.payload.region);
      return null;
    case "windows.setThumbnailToolTip":
      supported(
        window.setThumbnailToolTip,
        unsupportedThumbnailToolTip,
      )(call.payload.toolTip);
      return null;
    case "windows.setOverlayIcon":
      // The provider validates the ICO before any native call; null removes the overlay.
      supported(window.setOverlayIcon, unsupportedOverlayIcon)(
        call.payload.ico === null
          ? null
          : overlayIconProvider(call.payload.ico),
        call.payload.description,
      );
      return null;
    default:
      return UNHANDLED;
  }
}

const ACTION_GROUPS: readonly ActionGroup[] = [
  applyWebContent,
  applyLifecycle,
  applyRelations,
  applyAppearance,
  applyUserControls,
  applyDisplayState,
  applyGeometry,
  applySizeLimits,
  applyTaskbar,
];
