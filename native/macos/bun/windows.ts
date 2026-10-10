import type {
  NativeWindow,
  NativeWindowServices,
  WindowSpec,
  WindowState,
} from "@bunaway/plugin-api/native";
import { BunawayError, type ServerMessage } from "@bunaway/protocol";
import { ViewBoundary } from "@bunaway/runtime-bun/view-boundary";
import type { Packet, Route } from "@bunaway/runtime-bun/worker-channel";
import type { MacosApplication } from "./application.ts";
import type { MacosConfig } from "./config.ts";
import { macosOrigin } from "./urls.ts";
import { MacosWebview } from "./webview.ts";

const WINDOW_STARTUP_TIMEOUT_MS = 30_000;
const unsupported = (): never => {
  throw new BunawayError({
    code: "UNSUPPORTED",
    message: "Window operation is not implemented on macOS.",
  });
};
type View = {
  state: WindowState;
  /** Startup windows end the app on setup failure; dynamic creation reports to its caller. */
  startup: boolean;
  boundary: ViewBoundary;
  native?: MacosWebview | undefined;
};

/** Own each window's native resources and protocol boundary; closing one view leaves the others live. */
export class MacosWindows {
  private readonly views = new Map<string, View>();
  readonly services: NativeWindowServices;

  constructor(
    private readonly config: MacosConfig,
    private readonly application: MacosApplication,
    private readonly hooks: {
      ready(): boolean;
      stopping(): boolean;
      busy(): boolean;
      cancelled(requestId: string): boolean;
      forward(packet: Packet): void;
      capacity(count: number, pending: number): boolean;
      log(event: string, fields?: object): void;
      fail(error: unknown): void;
      quit(): void;
    },
  ) {
    this.services = {
      specs: config.windows,
      read: (view) => this.views.get(view)?.state,
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
    const view: View = {
      startup,
      state: {
        closed: false,
        cleaned: false,
        ready: false,
        failure: undefined,
        deadline: Date.now() + WINDOW_STARTUP_TIMEOUT_MS,
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
      }),
    };
    this.views.set(spec.view, view);
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
        if (view.startup) {
          this.hooks.fail(error);
        }
        this.closeView(spec.view);
        log("window-creation-failed");
      });
    } catch (error) {
      view.state.failure = error;
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
    this.hooks.log("window-closed", {
      view: viewId,
    });
    this.maybeQuit();
    return true;
  }

  private window(viewId: string): NativeWindow {
    const native = this.views.get(viewId)?.native;
    if (!native) {
      throw new Error("Missing native window.");
    }
    return {
      getSnapshot: unsupported,
      getReadiness: unsupported,
      show: (visible) => native.show(visible),
      showInactive: unsupported,
      focus: () => native.focus(),
      activate: unsupported,
      close: () => this.closeView(viewId),
      isVisible: () => native.isVisible(),
      isFocused: () => native.isFocused(),
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
        if (view.startup) {
          this.hooks.fail(view.state.failure);
        }
        this.closeView(view.boundary.policy.id);
      }
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
