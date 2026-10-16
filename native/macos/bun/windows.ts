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
  type JsonValue,
  type ServerMessage,
} from "@bunaway/protocol";
import { ViewBoundary } from "@bunaway/runtime-bun/view-boundary";
import type { Packet, Route } from "@bunaway/runtime-bun/worker-channel";
// Platform-neutral logic shared with the Windows host; none of it has a native dependency.
import {
  type CloseDecision,
  CloseRequests,
} from "../../windows/bun/close-request.ts";
import { WindowReadinessTracker } from "../../windows/bun/window-readiness.ts";
import type { MacosApplication } from "./application.ts";
import { assertMacosWindowOptions, type MacosConfig } from "./config.ts";
import type { DesktopRequests } from "./desktop-requests.ts";
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
/** Lifetime transitions of one windowId, as published by the `windows.lifecycle` event. */
type WindowLifecyclePhase = "created" | "ready" | "closed" | "destroyed";
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
  /**
   * Creation that replaces a window that was live. It counts as live for `windows-empty` until its
   * WebView is ready, so a recreation is not mistaken for an empty app.
   */
  replacing: boolean;
  boundary: ViewBoundary;
  native?: MacosWebview | undefined;
  /** The `windows.closeRequested` question this window lifetime may have pending. */
  closeRequests: CloseRequests;
  /** A user close of this window is waiting for the app or a quit decision; repeated closes are ignored. */
  closing: boolean;
  /** Phases already published for this windowId; each is emitted at most once. */
  publishedLifecycle: Set<WindowLifecyclePhase>;
};

/** Own each window's native resources and protocol boundary; closing one view leaves the others live. */
export class MacosWindows {
  private readonly views = new Map<string, View>();
  /** Window that most recently became key; cleared when that window closes. */
  private lastActiveWindowId: string | undefined;
  /** A show request (desktop control, Dock reopen) that the tick has not applied yet. */
  private showRequested = false;
  /** Whether any window has been live since the last `windows-empty`, so it fires once per transition. */
  private windowsWereLive = false;
  private windowsEmptyReported = false;
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
      /** Close behavior, quit requests and requests deferred until the backend reported its options. */
      desktop: DesktopRequests;
      /** The last live window vanished without a user decision and the app is not resident: shut down. */
      windowsGone(): void;
      /** Every live window closed while the app stays resident (`keep-alive`). */
      windowsEmpty(): void;
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
      create: (spec, replacingLiveWindow) =>
        this.create(spec, false, replacingLiveWindow === true),
      close: (view) => this.closeForReplacement(view),
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
  private create(spec: WindowSpec, startup = false, replacing = false): void {
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
      replacing,
      closeRequests: new CloseRequests(),
      closing: false,
      publishedLifecycle: new Set(),
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
        subscriptionEnded: (event) => {
          // Without a confirmed listener left nobody can answer the pending question; a pending or
          // rejected listen does not count. Cancelling keeps the window open.
          if (
            event === "windows.closeRequested" &&
            !view.boundary.subscribed("windows.closeRequested")
          ) {
            view.closeRequests.cancel();
          }
        },
        revoked: (reason, generation, error) => {
          // The question was asked of the revoked document session, which can no longer answer it.
          view.closeRequests.cancel();
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
          publish: (state) => {
            this.publishReadiness(state);
            if (state.document === "ready") {
              const current = this.viewById(state.windowId);
              if (current) {
                this.publishLifecycle(current, "ready");
              }
            }
          },
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
          // The title bar and performClose: reach here (the minimal main menu has no Close item, so Cmd+W does not); the window stays until the close order decides.
          close: () => {
            void this.closeByUser(view, "user").catch(this.hooks.fail);
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
        view.replacing = false;
        // The native window and WebView controller exist and the content rules are installed; a
        // lifetime whose setup failed or timed out never reaches this point and announces nothing.
        if (this.views.get(spec.view) === view) {
          this.publishLifecycle(view, "created");
        }
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
        this.commitClose(view);
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

  /**
   * Retires a window's sessions and marks it closed; the tick releases the native resources later,
   * outside delegate callbacks. Forced paths (creation failure, recreation) and an approved user
   * close all end here. Returns false when the window was already closed.
   */
  private commitClose(view: View): boolean {
    if (view.state.closed) {
      return false;
    }
    // A forced or recreating close ends any wait on the app before the sessions are revoked.
    view.closeRequests.cancel();
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
      view: view.boundary.policy.id,
    });
    // The closing window's own boundary is revoked, so it never receives its own `closed`.
    this.publishLifecycle(view, "closed");
    return true;
  }

  /** The window the coordinator is about to replace: closed without asking the app, but not while a close is pending. */
  private closeForReplacement(viewId: string): boolean {
    const view = this.views.get(viewId);
    if (!view || view.state.closed) {
      return false;
    }
    if (view.closing) {
      throw new BunawayError({
        code: "BUSY",
        message: "Window close is already pending.",
      });
    }
    return this.commitClose(view);
  }

  /**
   * Handles a user-style close (title bar, `performClose:`, public `windows.close`).
   * The order is: the window's own `windows.closeRequested` question when its document listens,
   * then, for the last live window with `closeBehavior: "quit"`, the app's `beforeQuit` through a
   * quit request, then the close itself. Close confirmation does not exist on macOS.
   *
   * The last window stays open, with its sessions, while the quit request is pending: only an
   * approved quit shuts it down, and a veto leaves everything as it was. Resolves true once the
   * window is closed or shutdown has begun, false when the close was declined or ignored.
   *
   * @param source `user` closes are ignored while another close of the window is pending; the public
   * `api` close reports BUSY instead.
   */
  private async closeByUser(
    view: View,
    source: "user" | "api",
  ): Promise<boolean> {
    if (view.state.closed || this.views.get(view.boundary.policy.id) !== view) {
      return true;
    }
    if (view.closing) {
      if (source === "api") {
        throw new BunawayError({
          code: "BUSY",
          message: "Window close is already pending.",
        });
      }
      return false;
    }
    view.closing = true;
    try {
      if (this.appDecidesClose(view)) {
        const decision = await this.askAppToDecideClose(view);
        if (view.state.closed || this.hooks.stopping()) {
          return true;
        }
        // A cancelled request counts as not approved: the document that was asked is gone.
        if (decision !== "allow") {
          return false;
        }
      }
      // The close behavior comes from the backend; a close that beats it waits here.
      const desktop = await this.hooks.desktop.configured();
      if (!desktop || view.state.closed || this.hooks.stopping()) {
        return true;
      }
      const otherLiveWindows = [
        ...this.views.values(),
      ].some((other) => other !== view && !other.state.closed);
      if (
        desktop.closeBehavior === "quit" &&
        (this.hooks.desktop.quitPending || !otherLiveWindows)
      ) {
        await this.hooks.desktop.requestQuit("last-window");
        return view.state.closed || this.hooks.stopping();
      }
      this.commitClose(view);
      return true;
    } finally {
      view.closing = false;
    }
  }

  /**
   * Whether the app asked to decide this window's user close itself: no quit is pending, and the
   * window's current document holds a confirmed `windows.closeRequested` subscription and may
   * answer with `windows.respondClose`. Without a subscription the close never waits on an app,
   * and a policy that cannot answer would otherwise wait forever.
   */
  private appDecidesClose(view: View): boolean {
    return (
      !this.hooks.desktop.quitPending &&
      !this.hooks.stopping() &&
      this.hooks.observes(view.boundary.policy.host, {
        operation: "windows.respondClose",
        payload: {
          view: view.boundary.policy.id,
        },
      }) &&
      view.boundary.subscribed("windows.closeRequested")
    );
  }

  /**
   * Asks the window's own document whether it may close and waits for the answer. The wait ends
   * only by `respondClose` or a cancellation: revocation or navigation of the document, the
   * document ending its last subscription, an undeliverable event, a forced close or shutdown.
   * There is no deadline.
   */
  private askAppToDecideClose(view: View): Promise<CloseDecision> {
    const { requestId, decision } = view.closeRequests.begin();
    const { windowId, viewId } = view.readiness.snapshot();
    this.sendNativeEvent(
      view.boundary,
      "windows.closeRequested",
      {
        windowId,
        viewId,
        requestId,
      },
      () => view.closeRequests.cancel(requestId),
    );
    return decision;
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
      this.sendNativeEvent(recipient.boundary, "windows.readiness", {
        ...state,
      });
    }
  }

  /**
   * Tells open sessions that may enumerate instances about one lifetime phase of a window.
   * Each phase is published at most once per windowId. Shutdown suppresses delivery because the
   * sessions are being torn down. Every later phase requires `created`, so a lifetime whose
   * WebView never became ready (creation failed or timed out) emits no lifecycle events at all.
   * Recipients need a `windows.lifecycle` subscription and the `windows.listInstances` permission,
   * the same boundary as listing windows, because the event exposes every window.
   */
  private publishLifecycle(view: View, phase: WindowLifecyclePhase): void {
    if (
      this.hooks.stopping() ||
      view.publishedLifecycle.has(phase) ||
      (phase !== "created" && !view.publishedLifecycle.has("created"))
    ) {
      return;
    }
    view.publishedLifecycle.add(phase);
    const { windowId, viewId } = view.readiness.snapshot();
    for (const recipient of this.views.values()) {
      if (
        !recipient.boundary.eventRoute("windows.lifecycle") ||
        !this.hooks.observes(recipient.boundary.policy.host, {
          operation: "windows.listInstances",
          payload: null,
        })
      ) {
        continue;
      }
      this.sendNativeEvent(recipient.boundary, "windows.lifecycle", {
        windowId,
        viewId,
        phase,
      });
    }
  }

  /**
   * Sends one event on the ordered native-event lane of the recipient's current document.
   * `onUndelivered` runs when the event could not be sent; a full lane revokes the receiving session,
   * because a lost transition would leave it with a stale view of the windows.
   */
  private sendNativeEvent(
    boundary: ViewBoundary,
    event: string,
    payload: JsonValue,
    onUndelivered?: () => void,
  ): void {
    const route = boundary.eventRoute(event);
    if (!route) {
      onUndelivered?.();
      return;
    }
    void this.hooks
      .nativeEvent({
        kind: "native-event",
        route,
        event,
        payload,
      })
      .catch((error) => {
        onUndelivered?.();
        if (this.hooks.stopping() || !boundary.matches(route)) {
          return;
        }
        if (error instanceof BunawayError && error.code === "BUSY") {
          boundary.fail(route, {
            code: "BUSY",
            message: "Native event queue full.",
          });
          return;
        }
        this.hooks.fail(error);
      });
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
      close: () => this.closeByUser(view, "api"),
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
      respondClose(requestId, allow) {
        if (!view.closeRequests.respond(requestId, allow)) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "No pending close request.",
          });
        }
      },
    };
  }

  /**
   * Asks to show the app: the next tick presents every live declared window, or creates the first
   * declared window when none is live. Repeated requests before that tick collapse into one.
   * Used by desktop control `show` and by a Dock reopen.
   */
  requestShow(): void {
    this.showRequested = true;
  }

  /**
   * Applies a pending show request. Live windows are presented (ordered front, key, app
   * activated). Without any, the first declared window is created once the old windows and any
   * `windows.create` or `windows.recreate` operation have finished, so it never races them.
   */
  private showDesktop(): void {
    if (!this.showRequested || this.hooks.stopping()) {
      return;
    }
    const live = this.config.windows.flatMap((spec) => {
      const view = this.views.get(spec.view);
      return view && !view.state.closed
        ? [
            view,
          ]
        : [];
    });
    if (live.length) {
      for (const view of live) {
        view.native?.present();
      }
      this.showRequested = false;
      return;
    }
    if (
      this.hooks.busy() ||
      [
        ...this.views.values(),
      ].some((view) => !view.state.cleaned)
    ) {
      return;
    }
    // Consumed before creating, so a failing creation is not retried every tick: the next reopen or
    // `show` request is the next attempt.
    this.showRequested = false;
    const first = this.config.windows[0];
    if (!first) {
      return;
    }
    try {
      this.create(first);
    } catch (error) {
      // `create` already marked the failed view closed and cleaned. A failed reopen must not end the
      // host through the UI pump; with `closeBehavior: "quit"` the missing window is then handled
      // like any other lost window by `quitWhenNoWindowRemains`, while `keep-alive` stays resident.
      this.hooks.log("reopen-window-creation-failed", {
        view: first.view,
        code: error instanceof BunawayError ? error.code : "INTERNAL",
      });
      return;
    }
    this.views.get(first.view)?.native?.present();
  }

  /**
   * Ends the app when no window can remain and the close behavior is `quit`, which covers a
   * window lost to a creation failure or timeout. A user close of the last window never gets here
   * because that window stays open until the quit is approved.
   */
  private quitWhenNoWindowRemains(): void {
    if (
      this.hooks.desktop.closeBehavior === "quit" &&
      !this.hooks.stopping() &&
      !this.hooks.busy() &&
      [
        ...this.views.values(),
      ].every((view) => view.state.closed)
    ) {
      this.hooks.windowsGone();
    }
  }

  /**
   * Tells the backend once per transition to zero live windows while the app stays resident.
   * Windows whose WebView is ready (the point where `created` is published) and windows still
   * replacing a live one count as live, so a recreation reports only if the replacement fails,
   * and then once. A new window still being created cannot re-arm the report, and one that fails
   * creation stays invisible. A pending recreation and shutdown never report.
   * Runs every tick so a window that becomes live again re-arms the next report.
   */
  private reportWindowsEmpty(): void {
    const anyLive = [
      ...this.views.values(),
    ].some(
      (view) => (view.state.ready || view.replacing) && !view.state.closed,
    );
    if (anyLive) {
      this.windowsWereLive = true;
      this.windowsEmptyReported = false;
      return;
    }
    if (
      !this.windowsWereLive ||
      this.windowsEmptyReported ||
      this.hooks.desktop.closeBehavior !== "keep-alive" ||
      this.hooks.stopping() ||
      this.hooks.busy()
    ) {
      return;
    }
    this.windowsEmptyReported = true;
    this.hooks.windowsEmpty();
  }

  start(): void {
    for (const view of this.views.values()) {
      view.native?.start();
    }
  }
  /**
   * Applies deferred native cleanup outside delegate callbacks, then checks creation deadlines,
   * pending show requests and the window-count transitions that end or idle the app.
   */
  tick(): void {
    this.showDesktop();
    for (const view of this.views.values()) {
      if (view.state.closed && !view.state.cleaned) {
        view.native?.close();
        view.native = undefined;
        view.state.cleaned = true;
        this.publishLifecycle(view, "destroyed");
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
        this.commitClose(view);
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
    this.quitWhenNoWindowRemains();
    this.reportWindowsEmpty();
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
      // Shutdown ends every wait on the app's close decision.
      view.closeRequests.cancel();
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
