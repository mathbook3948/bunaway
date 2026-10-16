import type {
  NativeWindow,
  NativeWindowServices,
  WindowIdentity,
  WindowReadiness,
  WindowSpec,
  WindowState,
} from "@bunaway/plugin-api/native";
import {
  API_LIMITS,
  BunawayError,
  type HostCall,
  type HostContext,
  type ServerMessage,
} from "@bunaway/protocol";
import { ViewBoundary } from "@bunaway/runtime-bun/view-boundary";
import type { Packet, Route } from "@bunaway/runtime-bun/worker-channel";
// Platform-neutral readiness logic shared with the Windows host; it has no native dependency.
import { WindowReadinessTracker } from "../../windows/bun/window-readiness.ts";
import type { MacosApplication } from "./application.ts";
import { assertMacosWindowOptions, type MacosConfig } from "./config.ts";
import { macosOrigin } from "./urls.ts";
import { MacosWebview } from "./webview.ts";

/** Bounds native setup and, separately, document and SDK preparation. */
const WINDOW_PREPARATION_TIMEOUT_MS = 30_000;
const unsupported = (): never => {
  throw new BunawayError({
    code: "UNSUPPORTED",
    message: "Window operation is not implemented on macOS.",
  });
};
type View = {
  /** Native lifetime ID, replaced whenever the view is created or recreated. */
  windowId: string;
  state: WindowState;
  /** Created before the native window, so a construction failure is still published and retained. */
  readiness: WindowReadinessTracker;
  documentDeadline: number;
  sdkDeadline: number;
  /** Startup windows end the app on setup failure; dynamic creation reports to its caller. */
  startup: boolean;
  boundary: ViewBoundary;
  native?: MacosWebview | undefined;
};

/** Own each window's native resources and protocol boundary; closing one view leaves the others live. */
export class MacosWindows {
  private readonly views = new Map<string, View>();
  /** Window that most recently became key; cleared when that window closes. */
  private lastActiveWindowId: string | undefined;
  readonly services: NativeWindowServices;

  constructor(
    private readonly config: MacosConfig,
    private readonly application: MacosApplication,
    private readonly hooks: {
      ready(): boolean;
      stopping(): boolean;
      busy(): boolean;
      cancelled(requestId: string): boolean;
      /** Host context that issued an in-flight request, if it is still tracked. */
      requestContext(requestId: string): HostContext | undefined;
      forward(packet: Packet): void;
      /**
       * Whether the recipient's host permissions allow the call and its operation is
       * registered; readiness events are gated by the getReadiness operation.
       */
      observes(host: ViewBoundary["policy"]["host"], call: HostCall): boolean;
      /** Send one ordered native event; rejects when the channel queue is full or closed. */
      nativeEvent(
        packet: Extract<
          Packet,
          {
            kind: "native-event";
          }
        >,
      ): Promise<void>;
      capacity(count: number, pending: number): boolean;
      log(event: string, fields?: object): void;
      fail(error: unknown): void;
      quit(): void;
    },
  ) {
    this.services = {
      specs: config.windows,
      read: (view) => this.views.get(view)?.state,
      supportsCreationOptions: true,
      validateCreation: (spec) => assertMacosWindowOptions(spec),
      instances: () =>
        [
          ...this.views,
        ].map(([key, view]) => ({
          key,
          identity: this.identity(view),
        })),
      lookup: {
        byId: (windowId) => {
          const view = this.viewById(windowId);
          return view && !view.state.cleaned ? this.identity(view) : null;
        },
        byView: (viewId) => {
          const view = this.views.get(viewId);
          return view && !view.state.closed ? this.identity(view) : null;
        },
        byRequest: (requestId) => {
          const context = this.hooks.requestContext(requestId);
          const view =
            context &&
            [
              ...this.views.values(),
            ].find((item) => item.boundary.active(context));
          return view ? this.identity(view) : null;
        },
        focused: () => {
          const view = [
            ...this.views.values(),
          ].find((item) => !item.state.closed && item.native?.isFocused());
          return view ? this.identity(view) : null;
        },
        lastActive: () => {
          const view = this.lastActiveWindowId
            ? this.viewById(this.lastActiveWindowId)
            : undefined;
          return view && !view.state.closed ? this.identity(view) : null;
        },
      },
      create: (spec) => this.create(spec),
      close: (view) => this.closeView(view),
      window: (view) => this.window(view),
      stopping: hooks.stopping,
      cancelled: hooks.cancelled,
      now: () => Date.now(),
      tick: () => Bun.sleep(5),
    };
    try {
      for (const spec of config.windows) {
        if (spec.startup !== false) {
          this.create(spec, true);
        }
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** Own setup completion per generation so replacing a startup window cannot leave startup waiting on an old view. */
  private create(spec: WindowSpec, startup = false): void {
    const policy = this.config.policy.views.find(
      (view) => view.id === spec.view,
    );
    if (!policy) {
      throw new Error("Missing macOS view policy.");
    }
    const log = (event: string, fields: object = {}) =>
      this.hooks.log(event, {
        view: spec.view,
        ...fields,
      });
    const now = Date.now();
    const windowId = crypto.randomUUID();
    const view: View = {
      startup,
      windowId,
      documentDeadline: now + WINDOW_PREPARATION_TIMEOUT_MS,
      sdkDeadline: now + WINDOW_PREPARATION_TIMEOUT_MS,
      state: {
        closed: false,
        cleaned: false,
        ready: false,
        failure: undefined,
        deadline: now + WINDOW_PREPARATION_TIMEOUT_MS,
      },
      boundary: new ViewBoundary(policy, {
        origin: macosOrigin,
        source: () => view.native?.source() ?? "",
        ready: () => this.hooks.ready() && !this.hooks.stopping(),
        capacity: (count) =>
          this.hooks.capacity(
            count,
            [
              ...this.views.values(),
            ].reduce((total, item) => total + item.boundary.pendingCount, 0),
          ),
        forward: this.hooks.forward,
        deliver: (text) => view.native?.deliver(text),
        log,
        // The tracker is built in the same literal, so every hook resolves it lazily through `view`.
        sessionOpened: (route) => {
          view.sdkDeadline = Date.now() + API_LIMITS.handshakeTimeoutMs;
          view.readiness.sessionOpened(route.documentGeneration);
        },
        sdkReady: (route) =>
          view.readiness.sdkComplete(route.documentGeneration),
        revoked: (reason, generation, error) => {
          if (reason === "navigation") {
            view.documentDeadline = Date.now() + WINDOW_PREPARATION_TIMEOUT_MS;
            view.sdkDeadline = Date.now() + WINDOW_PREPARATION_TIMEOUT_MS;
            view.readiness.reset(generation);
          } else {
            view.readiness.sessionEnded(
              generation,
              error ?? {
                code: "CANCELLED",
                message: "SDK session ended.",
              },
            );
          }
        },
      }),
      readiness: new WindowReadinessTracker(
        windowId,
        spec.view,
        spec.showWhenReady,
        {
          publish: (state) => this.publishReadiness(state),
          show: () => {
            if (
              this.views.get(spec.view) === view &&
              !view.state.closed &&
              !this.hooks.stopping()
            ) {
              view.native?.present();
            }
          },
        },
      ),
    };
    this.views.set(spec.view, view);
    // Publish before native construction so subscribers also observe a creation failure.
    this.publishReadiness(view.readiness.snapshot());
    try {
      view.native = new MacosWebview(
        {
          ...this.config,
          window: spec,
        },
        {
          receive(source, raw) {
            view.boundary.sameDocument(source);
            view.boundary.receive(source, raw);
          },
          revoke: (reason) => view.boundary.revoke(reason),
          close: () => {
            this.closeView(spec.view);
          },
          activated: () => {
            this.lastActiveWindowId = view.windowId;
          },
          documentComplete: (error) => view.readiness.documentComplete(error),
          log,
          fail: this.hooks.fail,
        },
        this.application,
      );
      log("window-created");
      const ready = view.native.ready.then(() => {
        if (view.state.closed) {
          return;
        }
        view.state.ready = true;
        if (this.hooks.ready()) {
          view.native?.start();
        }
      });
      // Dynamic creation has no startup waiter; always observe its failure and close that view.
      void ready.catch((error) => {
        if (view.state.closed) {
          return;
        }
        view.state.failure = error;
        // Terminate first so closing does not overwrite the failure with CANCELLED.
        view.readiness.terminate({
          code: "INTERNAL",
          message: "WebView creation failed.",
        });
        if (view.startup) {
          this.hooks.fail(error);
        }
        this.closeView(spec.view);
        log("window-creation-failed");
      });
    } catch (error) {
      view.state.failure = error;
      // Publish and retain the failure; no native window exists to report it later.
      view.readiness.terminate({
        code: "INTERNAL",
        message: "WebView creation failed.",
      });
      view.state.closed = true;
      view.state.cleaned = true;
      throw error;
    }
  }

  private closeView(viewId: string): boolean {
    const view = this.views.get(viewId);
    if (!view || view.state.closed) {
      return false;
    }
    view.state.closed = true;
    view.boundary.closed = true;
    view.boundary.revoke("closing");
    view.readiness.terminate({
      code: "CANCELLED",
      message: "Window closed.",
    });
    if (this.lastActiveWindowId === view.windowId) {
      this.lastActiveWindowId = undefined;
    }
    this.hooks.log("window-closed", {
      view: viewId,
    });
    this.maybeQuit();
    return true;
  }

  /** Broadcast preparation to subscribed live sessions with getReadiness permission. */
  private publishReadiness(state: WindowReadiness): void {
    if (this.hooks.stopping()) {
      return;
    }
    for (const recipient of this.views.values()) {
      const route = recipient.boundary.eventRoute("windows.readiness");
      if (
        !route ||
        !this.hooks.observes(recipient.boundary.policy.host, {
          operation: "windows.getReadiness",
          payload: {
            view: state.viewId,
          },
        })
      ) {
        continue;
      }
      void this.hooks
        .nativeEvent({
          kind: "native-event",
          route,
          event: "windows.readiness",
          payload: {
            ...state,
          },
        })
        .catch((error) => {
          if (this.hooks.stopping() || !recipient.boundary.matches(route)) {
            return;
          }
          if (error instanceof BunawayError && error.code === "BUSY") {
            recipient.boundary.fail(route, {
              code: "BUSY",
              message: "Native event queue full.",
            });
            return;
          }
          this.hooks.fail(error);
        });
    }
  }

  private identity(view: View): WindowIdentity {
    return {
      windowId: view.windowId,
      viewId: view.boundary.policy.id,
    };
  }

  private viewById(windowId: string): View | undefined {
    return [
      ...this.views.values(),
    ].find((view) => view.windowId === windowId);
  }

  /**
   * Resolve the operation target. Readiness is retained on the view after close, so only
   * the native methods resolve the AppKit window lazily and fail once it is cleaned.
   */
  private window(viewId: string): NativeWindow {
    const view = this.views.get(viewId);
    if (!view) {
      throw new Error("Missing native window.");
    }
    const native = (): MacosWebview => {
      if (!view.native) {
        throw new Error("Missing native window.");
      }
      return view.native;
    };
    return {
      get webview() {
        return native().controls;
      },
      getSnapshot: unsupported,
      getReadiness: () => {
        return view.readiness.snapshot();
      },
      show: (visible) => native().show(visible),
      showInactive: () => native().showInactive(),
      focus: () => native().focus(),
      activate: unsupported,
      close: () => this.closeView(viewId),
      isVisible: () => native().isVisible(),
      isFocused: () => native().isFocused(),
      getBounds: unsupported,
      getDpi: unsupported,
      minimize: unsupported,
      maximize: unsupported,
      unmaximize: unsupported,
      restore: unsupported,
      toggleMaximize: unsupported,
      isMinimized: unsupported,
      isMaximized: unsupported,
      isFullscreen: unsupported,
      getSizeConstraints: unsupported,
      setSizeConstraints: unsupported,
      setSize: unsupported,
      setPosition: unsupported,
      setGeometry: unsupported,
      setFullscreen: unsupported,
      setCloseConfirmation: unsupported,
      respondClose: unsupported,
    };
  }

  private maybeQuit(): void {
    if (
      !this.hooks.stopping() &&
      !this.hooks.busy() &&
      ![
        ...this.views.values(),
      ].some((view) => !view.state.closed)
    ) {
      this.hooks.quit();
    }
  }
  start(): void {
    for (const view of this.views.values()) {
      view.native?.start();
    }
  }
  /** Apply deferred native cleanup outside delegate callbacks, then check creation deadlines and auto-quit. */
  tick(): void {
    for (const view of this.views.values()) {
      if (view.state.closed && !view.state.cleaned) {
        view.native?.close();
        view.native = undefined;
        view.state.cleaned = true;
      }
      if (
        !view.state.closed &&
        !view.state.ready &&
        Date.now() > view.state.deadline
      ) {
        view.state.failure = new Error("macOS window setup timed out.");
        view.readiness.terminate({
          code: "TIMEOUT",
          message: "WebView creation timed out.",
        });
        if (view.startup) {
          this.hooks.fail(view.state.failure);
        }
        this.closeView(view.boundary.policy.id);
      }
      if (!view.state.closed) {
        if (Date.now() > view.documentDeadline) {
          view.readiness.expireDocument();
        }
        if (Date.now() > view.sdkDeadline) {
          view.readiness.expireSdk();
        }
      }
      view.native?.observeStartup();
      view.boundary.scanDeadlines();
    }
    this.maybeQuit();
  }
  boundary(
    context: import("@bunaway/protocol").HostContext,
  ): ViewBoundary | undefined {
    return [
      ...this.views.values(),
    ].find((view) => view.boundary.active(context))?.boundary;
  }
  send(route: Route, message: ServerMessage): void {
    this.views.get(route.viewId)?.boundary.send(route, message);
  }
  revoke(): void {
    for (const view of this.views.values()) {
      view.boundary.closed = true;
      view.boundary.revoke("closing");
      view.readiness.terminate({
        code: "CANCELLED",
        message: "App shutdown.",
      });
    }
  }
  close(): void {
    this.revoke();
    for (const view of this.views.values()) {
      view.state.closed = true;
      view.native?.close();
      view.native = undefined;
      view.state.cleaned = true;
    }
    this.views.clear();
  }
}
