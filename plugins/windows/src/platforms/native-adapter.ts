import type { NativeAdapter, NativeEnvironment } from "@bunaway/plugin";
import {
  hasValidWindowSizeConstraints,
  type WindowAttentionMode,
  type WindowIdentity,
  type WindowSizeConstraints,
} from "@bunaway/plugin-api/native";
import { BunawayError, type JsonValue } from "@bunaway/protocol";
import { validateWindowCall, type WindowCall } from "#windows/contract";
import { WindowOperations } from "#windows/platforms/coordinator";
import { convertGeometry } from "#windows/platforms/window-geometry";

/** Flash mode applied when `windows.requestAttention` omits `mode`. */
const DEFAULT_ATTENTION_MODE: WindowAttentionMode = "untilFocused";

function unsupportedRelations() {
  return new BunawayError({
    code: "UNSUPPORTED",
    message: "Window ownership control is not implemented on this platform.",
  });
}

function unsupportedFocusability() {
  return new BunawayError({
    code: "UNSUPPORTED",
    message: "Window focusability is not implemented on this platform.",
  });
}

function unsupportedControls() {
  return new BunawayError({
    code: "UNSUPPORTED",
    message: "Native caption controls are not implemented on this platform.",
  });
}

function unsupportedTitle() {
  return new BunawayError({
    code: "UNSUPPORTED",
    message: "Window title control is not implemented on this platform.",
  });
}

function unsupportedDisplay() {
  return new BunawayError({
    code: "UNSUPPORTED",
    message: "Window display options are not implemented on this platform.",
  });
}

function unsupportedAttention() {
  return new BunawayError({
    code: "UNSUPPORTED",
    message: "Window attention requests are not implemented on this platform.",
  });
}

function unsupportedMovement() {
  return new BunawayError({
    code: "UNSUPPORTED",
    message: "Window movement controls are not implemented on this platform.",
  });
}

/** Create the UI-worker adapter; throws when window services are unavailable. */
export function createOperations(
  environment: NativeEnvironment,
): NativeAdapter {
  if (!environment.windows) {
    throw new Error("Window services require the UI thread.");
  }
  const services = environment.windows;
  function applyWindow(
    call: WindowCall,
    viewId: string,
  ): JsonValue | Promise<JsonValue> {
    const window = services.window(viewId);
    const downloads = () => {
      if (!window.downloads) {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "WebView downloads are not implemented on this platform.",
        });
      }
      return window.downloads;
    };
    const webview = () => {
      if (!window.webview) {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "WebView control is not implemented on this platform.",
        });
      }
      return window.webview;
    };
    const audio = () => {
      if (!window.audio) {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message:
            "WebView audio controls are not implemented on this platform.",
        });
      }
      return window.audio;
    };
    switch (call.operation) {
      case "windows.getMonitor":
        if (!window.getMonitor) {
          throw new BunawayError({
            code: "UNSUPPORTED",
            message: "Monitor queries are unavailable.",
          });
        }
        return {
          ...window.getMonitor(),
        };
      case "windows.showPrintUI":
        if (!window.showPrintUI) {
          throw new BunawayError({
            code: "UNSUPPORTED",
            message:
              "WebView print dialogs are not implemented on this platform.",
          });
        }
        window.showPrintUI(call.payload.kind ?? "browser");
        break;
      case "windows.setDownloadRequestsEnabled":
        downloads().setRequestsEnabled(call.payload.enabled);
        break;
      case "windows.getDownloads":
        return downloads()
          .list()
          .map((download) => ({
            ...download,
          }));
      case "windows.approveDownload":
        downloads().approve(call.payload.id);
        break;
      case "windows.cancelDownload":
        downloads().cancel(call.payload.id);
        break;
      case "windows.pauseDownload":
        downloads().pause(call.payload.id);
        break;
      case "windows.resumeDownload":
        downloads().resume(call.payload.id);
        break;
      case "windows.forgetDownload":
        downloads().forget(call.payload.id);
        break;
      case "windows.getWebViewState":
        return {
          ...webview().getState(),
        };
      case "windows.navigateWebView":
        webview().navigate(call.payload.url);
        break;
      case "windows.reloadWebView":
        webview().reload();
        break;
      case "windows.stopWebView":
        webview().stop();
        break;
      case "windows.goBack":
        return webview().goBack();
      case "windows.goForward":
        return webview().goForward();
      case "windows.setZoomFactor":
        return webview().setZoomFactor(call.payload.factor);
      case "windows.openDevTools":
        webview().openDevTools();
        break;
      case "windows.getWebViewAudioState":
        return {
          ...audio().getState(),
        };
      case "windows.setWebViewAudioMuted":
        audio().setMuted(call.payload.muted);
        break;
      case "windows.getReadiness":
        return {
          ...window.getReadiness(),
        };
      case "windows.completeSplashscreen": {
        if (viewId === call.payload.splash) {
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
        const splash = services.read(call.payload.splash);
        if (!splash || splash.closed) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "Splashscreen is not open.",
          });
        }
        // Closing an owner also retires descendants, so validate before either window changes.
        for (
          let parent = window.getParent?.();
          parent;
          parent = services.window(identityKey(parent)).getParent?.()
        ) {
          if (parent.viewId === call.payload.splash) {
            throw new BunawayError({
              code: "INVALID_ARGUMENT",
              message: "Splashscreen cannot own the main window.",
            });
          }
        }
        // Final handoff preserves confirmation and bypasses quit/hide, without reserving
        // another splash lifetime or retaining its isolated profile.
        window.show(true);
        return services.close(call.payload.splash, false);
      }
      case "windows.getSnapshot":
        return {
          ...window.getSnapshot(),
        };
      case "windows.show":
        window.show(true);
        break;
      case "windows.showInactive":
        window.showInactive();
        break;
      case "windows.hide":
        window.show(false);
        break;
      case "windows.focus":
        if (!window.focus()) {
          throw new BunawayError({
            code: "BUSY",
            message: "OS declined window focus.",
          });
        }
        break;
      case "windows.activate":
        return window.activate();
      case "windows.blur": {
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
            operations.replacing.has(candidate.key)
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
      case "windows.close":
        return window.close();
      case "windows.respondClose":
        if (!window.respondClose) {
          throw new BunawayError({
            code: "UNSUPPORTED",
            message: "Close requests are not implemented on this platform.",
          });
        }
        window.respondClose(call.payload.requestId, call.payload.allow);
        break;
      case "windows.destroy":
        if (!window.destroy) {
          throw unsupportedRelations();
        }
        return window.destroy();
      case "windows.setParent":
        if (!window.setParent) {
          throw unsupportedRelations();
        }
        window.setParent(call.payload.parent, call.payload.modal);
        break;
      case "windows.getParent":
      case "windows.getOwner": {
        if (!window.getParent) {
          throw unsupportedRelations();
        }
        const parent = window.getParent();
        return parent &&
          services.specs.some((spec) => spec.view === parent.viewId) &&
          !operations.replacing.has(identityKey(parent))
          ? {
              ...parent,
            }
          : null;
      }
      case "windows.getChildren":
        if (!window.getChildren) {
          throw unsupportedRelations();
        }
        return window
          .getChildren()
          .filter(
            (child) =>
              services.specs.some((spec) => spec.view === child.viewId) &&
              !operations.replacing.has(identityKey(child)),
          )
          .map((child) => ({
            ...child,
          }));
      case "windows.setEnabled":
        if (!window.setEnabled) {
          throw unsupportedRelations();
        }
        window.setEnabled(call.payload.enabled);
        break;
      case "windows.isEnabled":
        if (!window.isEnabled) {
          throw unsupportedRelations();
        }
        return window.isEnabled();
      case "windows.getTitlebar":
        if (!window.getTitlebar) {
          throw unsupportedDisplay();
        }
        return window.getTitlebar();
      case "windows.setAlwaysOnTop":
        if (!window.setAlwaysOnTop) {
          throw unsupportedDisplay();
        }
        window.setAlwaysOnTop(call.payload.alwaysOnTop);
        break;
      case "windows.isAlwaysOnTop":
        if (!window.isAlwaysOnTop) {
          throw unsupportedDisplay();
        }
        return window.isAlwaysOnTop();
      case "windows.setSkipTaskbar":
        if (!window.setSkipTaskbar) {
          throw unsupportedDisplay();
        }
        window.setSkipTaskbar(call.payload.skipTaskbar);
        break;
      case "windows.isSkipTaskbar":
        if (!window.isSkipTaskbar) {
          throw unsupportedDisplay();
        }
        return window.isSkipTaskbar();
      case "windows.setContentProtection":
        if (!window.setContentProtection) {
          throw unsupportedDisplay();
        }
        window.setContentProtection(call.payload.contentProtection);
        break;
      case "windows.isContentProtected":
        if (!window.isContentProtected) {
          throw unsupportedDisplay();
        }
        return window.isContentProtected();
      case "windows.requestAttention":
        if (!window.requestAttention) {
          throw unsupportedAttention();
        }
        window.requestAttention(call.payload.mode ?? DEFAULT_ATTENTION_MODE);
        break;
      case "windows.cancelAttention":
        if (!window.cancelAttention) {
          throw unsupportedAttention();
        }
        window.cancelAttention();
        break;
      case "windows.setFocusable":
        if (!window.setFocusable) {
          throw unsupportedFocusability();
        }
        window.setFocusable(call.payload.focusable);
        break;
      case "windows.isFocusable":
        if (!window.isFocusable) {
          throw unsupportedFocusability();
        }
        return window.isFocusable();
      case "windows.setMinimizable":
        if (!window.setMinimizable) {
          throw unsupportedControls();
        }
        window.setMinimizable(call.payload.minimizable);
        break;
      case "windows.isMinimizable":
        if (!window.isMinimizable) {
          throw unsupportedControls();
        }
        return window.isMinimizable();
      case "windows.setMaximizable":
        if (!window.setMaximizable) {
          throw unsupportedControls();
        }
        window.setMaximizable(call.payload.maximizable);
        break;
      case "windows.isMaximizable":
        if (!window.isMaximizable) {
          throw unsupportedControls();
        }
        return window.isMaximizable();
      case "windows.setClosable":
        if (!window.setClosable) {
          throw unsupportedControls();
        }
        window.setClosable(call.payload.closable);
        break;
      case "windows.isClosable":
        if (!window.isClosable) {
          throw unsupportedControls();
        }
        return window.isClosable();
      case "windows.setTitle":
        if (!window.setTitle) {
          throw unsupportedTitle();
        }
        window.setTitle(call.payload.title);
        break;
      case "windows.getTitle":
        if (!window.getTitle) {
          throw unsupportedTitle();
        }
        return window.getTitle();
      case "windows.setResizable":
        if (!window.setResizable) {
          throw unsupportedMovement();
        }
        window.setResizable(call.payload.resizable);
        break;
      case "windows.isResizable":
        if (!window.isResizable) {
          throw unsupportedMovement();
        }
        return window.isResizable();
      case "windows.setMovable":
        if (!window.setMovable) {
          throw unsupportedMovement();
        }
        window.setMovable(call.payload.movable);
        break;
      case "windows.isMovable":
        if (!window.isMovable) {
          throw unsupportedMovement();
        }
        return window.isMovable();
      case "windows.getContentSize":
      case "windows.getOuterSize":
      case "windows.getContentPosition":
      case "windows.getOuterPosition":
      case "windows.getContentBounds":
      case "windows.getOuterBounds":
      case "windows.getNormalBounds": {
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
      case "windows.minimize":
      case "windows.maximize":
      case "windows.unmaximize":
      case "windows.restore":
      case "windows.toggleMaximize":
        if (window.isFullscreen()) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "Exit fullscreen before changing window state.",
          });
        }
        switch (call.operation) {
          case "windows.minimize":
            window.minimize();
            break;
          case "windows.maximize":
            window.maximize();
            break;
          case "windows.unmaximize":
            window.unmaximize();
            break;
          case "windows.restore":
            window.restore();
            break;
          case "windows.toggleMaximize":
            window.toggleMaximize();
            break;
        }
        break;
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
          !window.isMinimized() &&
          !window.isMaximized() &&
          !window.isFullscreen()
        );
      case "windows.setSize":
        if (window.isFullscreen()) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "Exit fullscreen before changing size.",
          });
        }
        window.setSize(call.payload.width, call.payload.height);
        break;
      case "windows.setContentPosition":
      case "windows.setOuterSize":
      case "windows.setContentBounds":
      case "windows.setOuterBounds": {
        if (window.isFullscreen()) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "Exit fullscreen before changing window geometry.",
          });
        }
        const { view: _view, unit, ...geometry } = call.payload;
        const physical =
          unit === "logical"
            ? convertGeometry(geometry, window.getDpi(), "physical")
            : geometry;
        window.setGeometry(
          call.operation.startsWith("windows.setContent") ? "content" : "outer",
          physical,
        );
        break;
      }
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
      case "windows.setMinSize": {
        const constraints = window.getSizeConstraints();
        const next: WindowSizeConstraints = {
          ...constraints,
          minWidth: call.payload.width,
          minHeight: call.payload.height,
        };
        if (!hasValidWindowSizeConstraints(next)) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "Minimum window size cannot exceed the maximum size.",
          });
        }
        window.setSizeConstraints(next);
        break;
      }
      case "windows.setMaxSize": {
        const constraints = window.getSizeConstraints();
        const next: WindowSizeConstraints = {
          ...constraints,
          maxWidth: call.payload.width,
          maxHeight: call.payload.height,
        };
        if (!hasValidWindowSizeConstraints(next)) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message:
              "Maximum window size cannot be smaller than the minimum size.",
          });
        }
        window.setSizeConstraints(next);
        break;
      }
      case "windows.getSizeConstraints":
        return {
          ...window.getSizeConstraints(),
        };
      case "windows.setSizeConstraints": {
        // Omitted bounds mean no limit; validate the complete pair before changing either bound.
        const next: WindowSizeConstraints = {
          minWidth: call.payload.minWidth ?? null,
          minHeight: call.payload.minHeight ?? null,
          maxWidth: call.payload.maxWidth ?? null,
          maxHeight: call.payload.maxHeight ?? null,
        };
        if (!hasValidWindowSizeConstraints(next)) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "Minimum window size cannot exceed the maximum size.",
          });
        }
        window.setSizeConstraints(next);
        break;
      }
      case "windows.setPosition":
        if (window.isFullscreen()) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "Exit fullscreen before changing position.",
          });
        }
        window.setPosition(call.payload.x, call.payload.y);
        break;
      case "windows.center":
        if (window.isFullscreen()) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "Exit fullscreen before centering the window.",
          });
        }
        if (!window.center) {
          throw new BunawayError({
            code: "UNSUPPORTED",
            message: "Window centering is not implemented on this platform.",
          });
        }
        window.center();
        break;
      case "windows.setFullscreen":
        window.setFullscreen(call.payload.fullscreen);
        break;
      case "windows.setTaskbarProgress":
        if (!window.setTaskbarProgress) {
          throw new BunawayError({
            code: "UNSUPPORTED",
            message: "Taskbar progress is not implemented on this platform.",
          });
        }
        window.setTaskbarProgress(call.payload);
        break;
      case "windows.setCloseConfirmation":
        window.setCloseConfirmation(call.payload.message);
        break;
      default:
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Expected a window operation.",
        });
    }
    return null;
  }
  const operations = new WindowOperations(services.specs, {
    ...services,
    apply: applyWindow,
  });
  function identityKey(identity: WindowIdentity): string {
    return services.instances
      ? (operations.resolveKey(identity.viewId, identity.windowId) ??
          identity.viewId)
      : identity.viewId;
  }
  /**
   * Allows a close answer only from the trusted backend or from the document that was asked.
   * Request IDs are small increasing integers, so permission alone would let another window's
   * document approve a close and bypass that window's confirmation. The caller is identified by the
   * authenticated document session behind the host request, never by the payload, and fails closed
   * when the platform cannot provide that identity.
   */
  function assertAskedWindowAnswers(
    target: {
      view: string;
      windowId?: string;
    },
    source: string,
    requestId: string,
  ): void {
    if (source === "backend") {
      return;
    }
    const caller = services.lookup?.byRequest?.(requestId);
    if (
      !caller ||
      source !== `view:${caller.viewId}` ||
      caller.viewId !== target.view ||
      identityKey(caller) !==
        operations.resolveKey(target.view, target.windowId)
    ) {
      throw new BunawayError({
        code: "PERMISSION_DENIED",
        message:
          "Close requests are answered only by the asked window's document or the backend.",
      });
    }
  }
  return {
    execute() {
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Window control requires UI execution.",
      });
    },
    async executeUI(operation, input, source, context) {
      const call = validateWindowCall({
        operation,
        payload: input,
      });
      if (
        call.operation === "windows.getMonitors" ||
        call.operation === "windows.getMonitorSnapshot" ||
        call.operation === "windows.getPrimaryMonitor" ||
        call.operation === "windows.getMonitorNearestPoint" ||
        call.operation === "windows.getMonitorNearestRect" ||
        call.operation === "windows.getCursorPosition"
      ) {
        if (!context.permissions.permissions.includes(call.operation)) {
          throw new BunawayError({
            code: "PERMISSION_DENIED",
            message: "Monitor query permission required.",
          });
        }
        if (services.stopping() || services.cancelled(context.requestId)) {
          throw new BunawayError({
            code: "CANCELLED",
            message: "Monitor query cancelled.",
          });
        }
        const monitors = services.monitors;
        if (!monitors) {
          throw new BunawayError({
            code: "UNSUPPORTED",
            message: "Monitor queries are unavailable.",
          });
        }
        switch (call.operation) {
          case "windows.getMonitorSnapshot":
            if (!monitors.snapshot) {
              throw new BunawayError({
                code: "UNSUPPORTED",
                message: "Monitor events are unavailable.",
              });
            }
            return {
              ...monitors.snapshot(),
            };
          case "windows.getMonitors":
            return monitors.list().map((monitor) => ({
              ...monitor,
            }));
          case "windows.getPrimaryMonitor":
            return {
              ...monitors.primary(),
            };
          case "windows.getMonitorNearestPoint":
            return {
              ...monitors.nearestPoint(call.payload),
            };
          case "windows.getMonitorNearestRect":
            return {
              ...monitors.nearestRect(call.payload),
            };
          case "windows.getCursorPosition":
            return {
              ...monitors.cursor(),
            };
        }
      }
      if (
        [
          "windows.setDownloadRequestsEnabled",
          "windows.getDownloads",
          "windows.approveDownload",
          "windows.cancelDownload",
          "windows.pauseDownload",
          "windows.resumeDownload",
          "windows.forgetDownload",
        ].includes(call.operation) &&
        source !== "backend"
      ) {
        throw new BunawayError({
          code: "PERMISSION_DENIED",
          message: "WebView downloads require a trusted backend context.",
        });
      }
      if (
        (call.operation === "windows.list" ||
          call.operation === "windows.listInstances") &&
        !context.permissions.permissions.includes(call.operation)
      ) {
        throw new BunawayError({
          code: "PERMISSION_DENIED",
          message: "Window listing permission required.",
        });
      }
      if (
        call.operation === "windows.destroy" &&
        (source !== "backend" ||
          !context.permissions.permissions.includes(call.operation))
      ) {
        throw new BunawayError({
          code: "PERMISSION_DENIED",
          message: "Trusted backend destroy permission required.",
        });
      }
      if (
        call.operation === "windows.setParent" &&
        !context.permissions.permissions.includes(call.operation)
      ) {
        throw new BunawayError({
          code: "PERMISSION_DENIED",
          message: "Window relationship policy denied.",
        });
      }
      // Check permission before resolving configuration so unknown views do not bypass denial.
      if (!context.permissions.permissions.includes(call.operation)) {
        throw new BunawayError({
          code: "PERMISSION_DENIED",
          message: "Window policy denied.",
        });
      }
      if (call.operation === "windows.respondClose") {
        assertAskedWindowAnswers(call.payload, source, context.requestId);
      }
      if (
        call.operation === "windows.setParent" &&
        call.payload.parent !== null
      ) {
        const parent = services.lookup?.byId(call.payload.parent);
        if (!parent || services.read(identityKey(parent))?.closed !== false) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "Parent window lifetime is not open.",
          });
        }
        if (operations.replacing.has(identityKey(parent))) {
          throw new BunawayError({
            code: "BUSY",
            message: "Parent window is being recreated.",
          });
        }
      }
      if (
        call.operation === "windows.getById" ||
        call.operation === "windows.getCurrent" ||
        call.operation === "windows.getFocused" ||
        call.operation === "windows.getLastActive"
      ) {
        if (!context.permissions.permissions.includes(call.operation)) {
          throw new BunawayError({
            code: "PERMISSION_DENIED",
            message: "Window policy denied.",
          });
        }
        if (services.stopping() || services.cancelled(context.requestId)) {
          throw new BunawayError({
            code: "CANCELLED",
            message: "Window request cancelled.",
          });
        }
        const lookup = services.lookup;
        if (!lookup) {
          throw new BunawayError({
            code: "UNSUPPORTED",
            message:
              "Window identity lookup is not implemented on this platform.",
          });
        }
        let identity: WindowIdentity | null = null;
        switch (call.operation) {
          case "windows.getById":
            identity = lookup.byId(call.payload.windowId);
            break;
          case "windows.getCurrent": {
            if (source === "backend") {
              return null;
            }
            const viewId = source.startsWith("view:")
              ? source.slice("view:".length)
              : "";
            if (!services.specs.some((spec) => spec.view === viewId)) {
              throw new BunawayError({
                code: "PERMISSION_DENIED",
                message: "Invalid window call source.",
              });
            }
            // Host request IDs are mapped to authenticated contexts by the UI owner.
            if (lookup.byRequest) {
              identity = lookup.byRequest(context.requestId);
              if (identity && identity.viewId !== viewId) {
                throw new BunawayError({
                  code: "PERMISSION_DENIED",
                  message:
                    "Window source does not match its authenticated request.",
                });
              }
            } else if (
              services.read(viewId)?.closed === false &&
              !operations.replacing.has(viewId)
            ) {
              identity = lookup.byView(viewId);
            }
            break;
          }
          case "windows.getFocused":
            identity = lookup.focused();
            break;
          case "windows.getLastActive":
            identity = lookup.lastActive();
            break;
        }
        // Do not expose IDs for denied, closed or replacing views, and do not fall back to another window.
        if (
          !identity ||
          !services.specs.some((spec) => spec.view === identity.viewId) ||
          services.read(identityKey(identity))?.closed !== false ||
          operations.replacing.has(identityKey(identity))
        ) {
          return null;
        }
        return {
          ...identity,
        };
      }
      if (
        call.operation === "windows.completeSplashscreen" &&
        source === `view:${call.payload.splash}`
      ) {
        // Closing the caller's WebView revokes its route before the result can be delivered.
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message:
            "Complete the splashscreen handoff from the main window or backend.",
        });
      }
      return operations.execute(call, context.requestId);
    },
    busy: () => operations.replacing.size !== 0,
    dispose() {},
  };
}
