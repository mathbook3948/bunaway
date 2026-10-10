import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import type { WindowReadiness } from "@bunaway/plugin-api/native";
import {
  API_LIMITS,
  BunawayError,
  type HostContext,
  type HostResponse,
  type Policy,
} from "@bunaway/protocol";
import { ViewBoundary } from "@bunaway/runtime-bun/view-boundary";
import { hostResponse } from "../../host-api/bun/host-response.ts";
import { loadPluginCatalog } from "../../host-api/bun/plugin-catalog.ts";
import {
  disposeAll,
  operations,
  permissionMatcher,
  pluginRegistry,
} from "../../host-api/bun/plugins.ts";
import {
  Channel,
  type Packet,
  type UIConfig,
  type WindowSpec,
} from "./channel.ts";
import { callbackCalls, checkCallbacks, disposeCom } from "./com.ts";
import { Tray } from "./tray.ts";
import { originOf, WebView } from "./webview.ts";
import {
  Windows,
  WM_CLOSE,
  WM_ENTERSIZEMOVE,
  WM_EXITSIZEMOVE,
  WM_SIZE,
} from "./win32.ts";
import { disposeWin32Bindings, hr, kernel, ole } from "./win32-bindings.ts";
import { WindowReadinessTracker } from "./window-readiness.ts";
import { WindowRelations } from "./window-relations.ts";

const config = workerData as UIConfig;
const WINDOW_PREPARATION_TIMEOUT_MS = 30_000;
const packagedPlugins = await loadPluginCatalog(config.assets);
const registry = pluginRegistry(config.plugins ?? [], packagedPlugins);
registry.validatePolicy(config.policy);
const matches = await permissionMatcher(config.plugins ?? [], packagedPlugins);
assert(parentPort);
let failure: unknown;
let stopping = false;
let startupNavigationStarted = false;
let startRequested = false;
let closingSent = false;
let initialized = false;
let windows: Windows | undefined;
let adapters: Awaited<ReturnType<typeof operations>> | undefined;
let tray: Tray | undefined;
let quitPending = false;
function requestQuit(reason: "last-window" | "tray") {
  if (stopping || quitPending) {
    return;
  }
  quitPending = true;
  channel.notify({
    kind: "quit-request",
    reason,
  });
}
function visibility(action: "show" | "hide") {
  if (stopping) {
    return;
  }
  const nativeWindows = windows;
  if (!nativeWindows) {
    return;
  }
  for (const view of views.values()) {
    if (view.boundary.closed) {
      continue;
    }
    if (action === "show") {
      nativeWindows.focus(view.native.hwnd);
    } else {
      nativeWindows.show(view.native.hwnd, false);
    }
  }
}
type ViewState = {
  boundary: ViewBoundary;
  native: WebView;
  detached: boolean;
  cleaned: boolean;
  ready: boolean;
  navigationStarted: boolean;
  pendingClose: boolean;
  forceClose: boolean;
  replacementCancelled: boolean;
  confirmation: string | null;
  deadline: number;
  documentDeadline: number;
  sdkDeadline: number;
  readiness: WindowReadinessTracker;
};
const views = new Map<string, ViewState>();
const closingWindows = new Set<string>();
const replacements = new Map<
  string,
  {
    parent: string | null;
    modal: boolean;
  }
>();
const modalWindows = new Set<string>();
const relations = new WindowRelations({
  setOwner: (child, parent) => {
    assert(windows);
    windows.setOwner(hwndById(child), parent === null ? 0n : hwndById(parent));
  },
  isEnabled: (id) => {
    assert(windows);
    return windows.isEnabled(hwndById(id));
  },
  setEnabled: (id, enabled) => {
    assert(windows);
    windows.setEnabled(hwndById(id), enabled);
  },
});

function hwndById(windowId: string): bigint {
  assert(windows);
  const identity = windows.getById(windowId);
  const view = identity && views.get(identity.viewId);
  assert(view, "Unknown native window lifetime");
  return view.native.hwnd;
}
/**
 * Defer detach while WebView creation is pending.
 * Destroy its HWND before finishing COM cleanup.
 */
function cleanupView(view: ViewState) {
  if (!view.boundary.closed || view.cleaned) {
    return;
  }
  const windowId = view.readiness.snapshot().windowId;
  if (!relations.canRelease(windowId)) {
    return;
  }
  if (!view.detached && view.native.detach()) {
    windows?.destroy(view.native.hwnd);
    view.detached = true;
  }
  if (view.detached && !view.cleaned) {
    if (view.native.finish()) {
      relations.release(windowId);
      modalWindows.delete(windowId);
      view.cleaned = true;
    }
  }
}
const cancelled = new Set<string>();
const windowRequests = new Map<string, HostContext>();
const operationControllers = new Map<string, AbortController>();
const approved = new Map<string, HostContext>();
const uiCalls = new Map<
  string,
  Extract<
    Packet,
    {
      kind: "operation";
    }
  >
>();
/** Drop queued work for a context and suppress results from its running operations. */
function discardContext(context: HostContext) {
  for (const [id, approvedContext] of approved) {
    if (approvedContext === context) {
      approved.delete(id);
    }
  }
  for (const [id, call] of uiCalls) {
    if (call.context === context) {
      uiCalls.delete(id);
    }
  }
  for (const [id, source] of windowRequests) {
    if (source === context) {
      cancelled.add(id);
      operationControllers.get(id)?.abort();
    }
  }
}
const fail = (error: unknown) => {
  failure ??= error;
  stopping = true;
};
const channel = new Channel(
  parentPort,
  config.runtime,
  "ui",
  (packet: Packet) => {
    if (packet.kind === "start") {
      assert(!startRequested && !stopping, "Invalid start");
      startRequested = true;
      startViews();
    } else if (packet.kind === "desktop-control") {
      if (packet.action === "hide") {
        assert(tray, "Hiding requires a tray");
      }
      visibility(packet.action);
    } else if (packet.kind === "quit-cancelled") {
      quitPending = false;
    } else if (packet.kind === "shutdown") {
      stopping = true;
      for (const controller of operationControllers.values()) {
        controller.abort();
      }
      approved.clear();
      uiCalls.clear();
      for (const view of views.values()) {
        relations.markClosing(view.readiness.snapshot().windowId);
        view.boundary.revoke("shutdown");
        view.readiness?.terminate({
          code: "CANCELLED",
          message: "App shutdown.",
        });
        view.boundary.closed = true;
        view.native.requestClose();
      }
    } else if (packet.kind === "server") {
      views
        .get(packet.route.viewId)
        ?.boundary.send(packet.route, packet.message);
    } else if (packet.kind === "session-failure") {
      discardContext(packet.route.context);
      const view = views.get(packet.route.viewId);
      if (view?.boundary.matches(packet.route)) {
        view.boundary.fail(packet.route, packet.error);
      }
    } else if (packet.kind === "operation") {
      assert(
        !stopping &&
          !uiCalls.has(packet.requestId) &&
          uiCalls.size < API_LIMITS.maxPending,
        "Invalid UI queue request",
      );
      uiCalls.set(packet.requestId, packet);
      channel.notify({
        kind: "prepare",
        context: packet.context,
        requestId: packet.requestId,
        call: packet.call,
      });
    } else if (packet.kind === "authorize" || packet.kind === "grant") {
      const queued =
        packet.kind === "grant" ? uiCalls.get(packet.requestId) : undefined;
      if (packet.kind === "grant") {
        if (!queued) {
          return;
        }
        assert(queued.context === packet.context);
        uiCalls.delete(packet.requestId);
      }
      const operation = packet.kind === "authorize" ? packet : queued;
      assert(operation);
      const view = [
        ...views.values(),
      ].find((view) => view.boundary.active(packet.context));
      const permissions =
        packet.context === config.backendContext
          ? config.policy.backend
          : view?.boundary.policy.host;
      const source =
        packet.context === config.backendContext
          ? "backend"
          : `view:${view?.boundary.policy.id ?? "invalid"}`;
      let allowed = false;
      try {
        const call = registry.validateCall(operation.call);
        allowed =
          !stopping &&
          !closingSent &&
          (packet.kind !== "grant" || packet.allowed) &&
          !!permissions &&
          (packet.kind !== "grant" || queued?.source === source) &&
          registry.allowed(permissions, call, matches);
      } catch {
        /* Invalid requests fail closed at the host boundary. */
      }
      if (!allowed) {
        log("host-request-denied", {
          operation: operation.call.operation,
        });
      }
      if (packet.kind === "grant") {
        assert(queued);
        return executeWindowRequest(queued, allowed, permissions);
      }
      if (allowed) {
        assert(!approved.has(packet.requestId));
        approved.set(packet.requestId, packet.context);
      }
      channel.notify({
        kind: "authorized",
        context: packet.context,
        requestId: packet.requestId,
        allowed,
      });
    } else if (packet.kind === "cancel") {
      approved.delete(packet.requestId);
      uiCalls.delete(packet.requestId);
      if (windowRequests.has(packet.requestId)) {
        cancelled.add(packet.requestId);
        operationControllers.get(packet.requestId)?.abort();
      }
    } else if (packet.kind === "cancel-context") {
      discardContext(packet.context);
    } else if (packet.kind === "host-result") {
      const active = activeContext(packet.context);
      const context = approved.get(packet.requestId);
      approved.delete(packet.requestId);
      if (!stopping && active && context === packet.context) {
        channel.notify({
          ...packet,
          kind: "host-response",
        });
      }
    } else {
      throw new Error("Unexpected UI packet");
    }
  },
  fail,
);

/** Keep asynchronous adapter completion separate so server deliveries can be acknowledged inside a native modal loop. */
async function executeWindowRequest(
  queued: Extract<
    Packet,
    {
      kind: "operation";
    }
  >,
  allowed: boolean,
  permissions: Policy["backend"] | undefined,
): Promise<void> {
  let response: HostResponse;
  windowRequests.set(queued.requestId, queued.context);
  const controller = new AbortController();
  operationControllers.set(queued.requestId, controller);
  try {
    if (!allowed || !permissions) {
      throw new BunawayError({
        code: "PERMISSION_DENIED",
        message: "Host context or policy denied.",
      });
    }
    assert(adapters, "UI adapters are not initialized");
    const payload = await adapters.executeUI(
      queued.call.operation,
      queued.call.payload,
      queued.source,
      {
        requestId: queued.requestId,
        permissions,
        signal: controller.signal,
      },
    );
    response = hostResponse(() => payload);
  } catch (error) {
    response = hostResponse(() => {
      throw error;
    });
  } finally {
    windowRequests.delete(queued.requestId);
    operationControllers.delete(queued.requestId);
  }
  const wasCancelled = cancelled.delete(queued.requestId);
  if (stopping || wasCancelled || !activeContext(queued.context)) {
    return;
  }
  channel.notify({
    kind: "host-response",
    context: queued.context,
    requestId: queued.requestId,
    response,
  });
}

const log = (event: string, data: Record<string, unknown> = {}) => {
  console.log(
    JSON.stringify({
      event,
      ...data,
    }),
  );
  channel.notify({
    kind: "diagnostic",
    event,
    fields: data,
  });
};
function activeContext(context: HostContext) {
  return (
    context === config.backendContext ||
    [
      ...views.values(),
    ].some((view) => view.boundary.active(context))
  );
}
/** Wait for startup views, then navigate each ready view once. */
function startViews() {
  if (
    !startRequested ||
    stopping ||
    (!startupNavigationStarted &&
      [
        ...views.values(),
      ].some((view) => !view.ready && !view.boundary.closed))
  ) {
    return;
  }
  startupNavigationStarted = true;
  for (const view of views.values()) {
    if (view.ready && !view.boundary.closed && !view.navigationStarted) {
      view.navigationStarted = true;
      view.native.navigate();
    }
  }
}
/**
 * Handle user close, window recreation, and forced shutdown requests.
 * Returns false if hidden or declined, including a cancelled final quit.
 */
async function closeWindow(
  viewId: string,
  mode: "close" | "recreate" | "force" = "close",
): Promise<boolean> {
  const view = views.get(viewId);
  assert(view);
  view.pendingClose = false;
  if (mode === "force") {
    replacements.delete(viewId);
  }
  if (view.boundary.closed) {
    return true;
  }
  assert(windows);
  const windowId = view.readiness.snapshot().windowId;
  const order = relations.closeOrder(windowId);
  const subtree = order.map((id) => {
    const entry = [
      ...views,
    ].find(([, child]) => child.readiness.snapshot().windowId === id);
    assert(entry);
    return {
      id,
      viewId: entry[0],
      view: entry[1],
    };
  });
  if (
    mode !== "force" &&
    subtree.some((child) => closingWindows.has(child.id))
  ) {
    throw new BunawayError({
      code: "BUSY",
      message: "Window close is already pending.",
    });
  }
  if (mode === "force") {
    for (const child of subtree) {
      if (child.view !== view) {
        child.view.replacementCancelled = true;
      }
      commitClose(child.viewId, child.view);
    }
    return true;
  }
  for (const child of subtree) {
    closingWindows.add(child.id);
  }
  try {
    if (
      mode === "close" &&
      config.desktop?.closeBehavior === "hide" &&
      !relations.getParent(windowId)
    ) {
      assert(tray, "Close to tray requires a tray");
      windows.show(view.native.hwnd, false);
      log("view-window-hidden", {
        view: viewId,
      });
      return false;
    }
    for (const child of subtree) {
      if (
        child.view.boundary.closed ||
        !child.view.confirmation ||
        (mode !== "recreate" && quitPending)
      ) {
        continue;
      }
      log("window-close-confirmation", {
        view: child.viewId,
      });
      const childSpec = config.windows.find(
        (candidate) => candidate.view === child.viewId,
      );
      assert(childSpec);
      if (
        !windows.confirmClose(
          child.view.native.hwnd,
          childSpec.title,
          child.view.confirmation,
        )
      ) {
        return view.boundary.closed;
      }
      if (stopping || closingSent || view.boundary.closed) {
        return true;
      }
    }
    // Native confirmation pumps messages, so recheck shutdown before committing closure.
    if (view.boundary.closed) {
      return true;
    }
    if (
      mode === "close" &&
      (quitPending ||
        [
          ...views.values(),
        ].filter(
          (candidate) =>
            !candidate.boundary.closed &&
            !subtree.some((child) => child.view === candidate),
        ).length === 0)
    ) {
      requestQuit("last-window");
      while (
        quitPending &&
        !view.boundary.closed &&
        !stopping &&
        !closingSent
      ) {
        await Bun.sleep(5);
      }
      return view.boundary.closed || stopping || closingSent;
    }
    if (mode === "recreate") {
      replacements.set(viewId, {
        parent: relations.getParent(windowId)?.windowId ?? null,
        modal: modalWindows.has(windowId),
      });
    }
    for (const child of subtree) {
      if (child.view !== view) {
        child.view.replacementCancelled = true;
      }
      commitClose(child.viewId, child.view);
    }
    return true;
  } finally {
    for (const child of subtree) {
      closingWindows.delete(child.id);
    }
  }
}

/** Retires sessions before native release. The cleanup pump releases descendants first. */
function commitClose(viewId: string, view: ViewState) {
  if (view.boundary.closed) {
    return;
  }
  relations.markClosing(view.readiness.snapshot().windowId);
  view.boundary.revoke("closing");
  view.readiness?.terminate({
    code: "CANCELLED",
    message: "Window closed.",
  });
  view.boundary.closed = true;
  view.native.requestClose();
  log("view-window-closed", {
    view: viewId,
  });
}
const windowServices: import("@bunaway/plugin-api/native").NativeWindowServices =
  {
    specs: config.windows,
    lookup: {
      byId: (windowId) => windows?.getById(windowId) ?? null,
      byView: (viewId) => windows?.getByView(viewId) ?? null,
      focused: () => windows?.getFocused() ?? null,
      lastActive: () => windows?.getLastActive() ?? null,
    },
    read: (viewId) => {
      const view = views.get(viewId);
      return view
        ? {
            closed: view.boundary.closed,
            cleaned: view.cleaned,
            ready: view.ready,
            failure: view.native.failure,
            replacementCancelled: view.replacementCancelled,
            deadline: view.deadline,
          }
        : undefined;
    },
    create: createWindow,
    close: (viewId) => closeWindow(viewId, "recreate"),
    destroy: (viewId) => closeWindow(viewId, "force"),
    stopping: () => stopping,
    cancelled: (id) => cancelled.has(id),
    now: () => Date.now(),
    tick: () => Bun.sleep(5),

    window(viewId) {
      const view = views.get(viewId);
      assert(view);
      assert(windows);
      const nativeWindows = windows;
      const hwnd = view.native.hwnd;
      return {
        getSnapshot: () => nativeWindows.getSnapshot(hwnd),
        getReadiness: () => {
          assert(view.readiness);
          return view.readiness.snapshot();
        },
        show: (visible) => nativeWindows.show(hwnd, visible),
        showInactive: () => nativeWindows.showInactive(hwnd),
        focus: () => nativeWindows.focus(hwnd),
        activate: () => nativeWindows.activate(hwnd),
        close: () => closeWindow(viewId),
        destroy: () => closeWindow(viewId, "force"),
        setParent(parent, modal) {
          const id = view.readiness.snapshot().windowId;
          if (
            closingWindows.has(id) ||
            (parent !== null && closingWindows.has(parent))
          ) {
            throw new BunawayError({
              code: "BUSY",
              message: "Window close is pending.",
            });
          }
          relations.setParent(id, parent, modal);
          if (modal) {
            modalWindows.add(id);
          } else {
            modalWindows.delete(id);
          }
        },
        getParent: () =>
          relations.getParent(view.readiness.snapshot().windowId),
        getChildren: () =>
          relations.getChildren(view.readiness.snapshot().windowId),
        setEnabled(enabled) {
          const id = view.readiness.snapshot().windowId;
          if (closingWindows.has(id)) {
            throw new BunawayError({
              code: "BUSY",
              message: "Window close is pending.",
            });
          }
          relations.setEnabled(id, enabled);
        },
        isEnabled: () => nativeWindows.isEnabled(hwnd),
        minimize: () => nativeWindows.minimize(hwnd),
        maximize: () => nativeWindows.maximize(hwnd),
        unmaximize: () => nativeWindows.unmaximize(hwnd),
        restore: () => nativeWindows.restore(hwnd),
        toggleMaximize: () => nativeWindows.toggleMaximize(hwnd),
        isMinimized: () => nativeWindows.isMinimized(hwnd),
        isMaximized: () => nativeWindows.isMaximized(hwnd),
        isFullscreen: () => nativeWindows.isFullscreen(hwnd),
        getBounds: (area) => nativeWindows.getBounds(hwnd, area),
        getDpi: () => nativeWindows.getDpi(hwnd),
        isVisible: () => nativeWindows.isVisible(hwnd),
        isFocused: () => nativeWindows.isFocused(hwnd),
        getSizeConstraints: () => nativeWindows.getSizeConstraints(hwnd),
        setSizeConstraints(constraints) {
          nativeWindows.setSizeConstraints(hwnd, constraints);
          view.native.resize();
        },
        setSize(width, height) {
          nativeWindows.setSize(hwnd, width, height);
          view.native.resize();
        },
        setPosition: (x, y) => nativeWindows.setPosition(hwnd, x, y),
        setGeometry(area, geometry) {
          nativeWindows.setGeometry(hwnd, area, geometry);
          view.native.resize();
        },
        setFullscreen(fullscreen) {
          nativeWindows.setFullscreen(hwnd, fullscreen);
          view.native.resize();
        },
        setCloseConfirmation(message) {
          view.confirmation = message;
        },
      };
    },
  };
/** Create the HWND and WebView, destroying the HWND if WebView setup fails. */
function createWindow(spec: WindowSpec, replacingLiveWindow = false) {
  assert(windows);
  const replacement = replacingLiveWindow
    ? replacements.get(spec.view)
    : undefined;
  replacements.delete(spec.view);
  if (replacement?.parent) {
    const parent = windows.getById(replacement.parent);
    if (
      !parent ||
      views.get(parent.viewId)?.boundary.closed ||
      closingWindows.has(replacement.parent)
    ) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Parent lifetime ended during recreation.",
      });
    }
  }

  const policy = config.policy.views.find((view) => view.id === spec.view);
  assert(policy);
  let native: WebView;
  const boundary = new ViewBoundary(policy, {
    origin: originOf,
    source: () => native.source(),
    ready: () => startupNavigationStarted && !stopping && !closingSent,
    capacity: (count) =>
      channel.canSend(
        count,
        [
          ...views.values(),
        ].reduce((total, view) => total + view.boundary.pendingCount, 0),
      ),
    forward: (packet) => {
      if (packet.kind === "revoke") {
        discardContext(packet.route.context);
      }
      channel.notify(packet);
    },
    deliver: (text) => native.send(text),
    log: (event, data) =>
      log(event, {
        view: spec.view,
        ...data,
      }),
    sessionOpened: (route) => {
      const view = views.get(spec.view);
      if (view) {
        view.sdkDeadline = Date.now() + API_LIMITS.handshakeTimeoutMs;
        view.readiness?.sessionOpened(route.documentGeneration);
      }
    },
    sdkReady: (route) =>
      views.get(spec.view)?.readiness?.sdkComplete(route.documentGeneration),
    revoked: (reason, generation, error) => {
      const view = views.get(spec.view);
      if (!view) {
        return;
      }
      if (reason === "navigation") {
        view.documentDeadline = Date.now() + WINDOW_PREPARATION_TIMEOUT_MS;
        view.sdkDeadline = Date.now() + WINDOW_PREPARATION_TIMEOUT_MS;
        view.readiness?.reset(generation);
      } else {
        view.readiness?.sessionEnded(
          generation,
          error ?? {
            code: "CANCELLED",
            message: "SDK session ended.",
          },
        );
      }
    },
  });
  const close = (force = false) => {
    const view = views.get(spec.view);
    if (view && !view.boundary.closed) {
      if (!force && closingWindows.has(view.readiness.snapshot().windowId)) {
        return;
      }
      if (force) {
        view.forceClose = true;
      }
      view.pendingClose = true;
    }
  };
  const window = windows.create(
    spec.title,
    spec.window.width,
    spec.window.height,
    (message) => {
      if (message === WM_CLOSE) {
        close();
      } else if (message === WM_SIZE) {
        native?.resize();
      } else if (message === WM_ENTERSIZEMOVE) {
        log("modal-enter", {
          view: spec.view,
        });
      } else if (message === WM_EXITSIZEMOVE) {
        log("modal-exit", {
          view: spec.view,
        });
      }
    },
    spec.visible !== false && !spec.showWhenReady,
    spec.window,
  );
  log("window-created", {
    view: spec.view,
    hwnd: window.toString(),
  });
  windows.observe(window, spec.view, (snapshot, changes) => {
    if (stopping || closingSent || views.get(spec.view)?.native !== native) {
      return;
    }
    sendNativeEvent(boundary, "windows.changed", {
      ...snapshot,
      changes,
    });
  });
  const readiness = new WindowReadinessTracker(
    windows.getSnapshot(window).windowId,
    spec.view,
    spec.showWhenReady,
    {
      publish: publishReadiness,
      show: () => {
        const current = views.get(spec.view);
        if (
          current &&
          current.native === native &&
          !current.boundary.closed &&
          !stopping &&
          !closingSent
        ) {
          windows?.show(window, true);
        }
      },
    },
  );
  publishReadiness(readiness.snapshot());
  // Record partial HWND ownership before environment creation can fail.
  try {
    native = new WebView(
      window,
      spec,
      config.assets,
      config.dataRoot,
      config.loader,
      policy.origins,
      {
        message: (source, raw) => boundary.receive(source, raw),
        revoke: (reason) => {
          boundary.revoke(reason);
          for (const [id, context] of approved) {
            if (!activeContext(context)) {
              approved.delete(id);
            }
          }
          for (const [id, call] of uiCalls) {
            if (!activeContext(call.context)) {
              uiCalls.delete(id);
            }
          }
        },
        sameDocument: (source) => boundary.sameDocument(source),
        documentComplete: (error) =>
          views.get(spec.view)?.readiness?.documentComplete(error),
        close,
        ready: () => {
          const view = views.get(spec.view);
          assert(view);
          view.ready = true;
          startViews();
        },
        log: (event, data) =>
          log(event, {
            view: spec.view,
            ...data,
          }),
      },
      config.legacyProfile,
      config.devtools,
    );
  } catch (error) {
    readiness.terminate({
      code: "INTERNAL",
      message: "WebView creation failed.",
    });
    windows.destroy(window);
    throw error;
  }
  views.set(spec.view, {
    readiness,
    boundary,
    native,
    detached: false,
    cleaned: false,
    ready: false,
    navigationStarted: false,
    pendingClose: false,
    forceClose: false,
    replacementCancelled: false,
    confirmation: null,
    deadline: Date.now() + WINDOW_PREPARATION_TIMEOUT_MS,
    documentDeadline: Date.now() + WINDOW_PREPARATION_TIMEOUT_MS,
    sdkDeadline: Date.now() + WINDOW_PREPARATION_TIMEOUT_MS,
  });
  const identity = windows.getByView(spec.view);
  assert(identity);
  relations.register(identity);
  if (replacement?.parent) {
    try {
      relations.setParent(
        identity.windowId,
        replacement.parent,
        replacement.modal,
      );
      if (replacement.modal) {
        modalWindows.add(identity.windowId);
      }
    } catch (error) {
      const view = views.get(spec.view);
      assert(view);
      commitClose(spec.view, view);
      throw error;
    }
  }
}

/** Broadcast preparation only to subscribed live sessions allowed to control the source window. */
function publishReadiness(state: WindowReadiness): void {
  if (
    stopping ||
    closingSent ||
    !registry.operations.has("windows.getReadiness")
  ) {
    return;
  }
  for (const recipient of views.values()) {
    const route = recipient.boundary.eventRoute("windows.readiness");
    if (
      !route ||
      !registry.allowed(
        recipient.boundary.policy.host,
        {
          operation: "windows.getReadiness",
          payload: {
            view: state.viewId,
          },
        },
        matches,
      )
    ) {
      continue;
    }
    sendNativeEvent(recipient.boundary, "windows.readiness", {
      ...state,
    });
  }
}
/** Reuse the ordered native-event lane; a lost transition revokes its receiving session. */
function sendNativeEvent(
  boundary: ViewBoundary,
  event: string,
  payload: import("@bunaway/protocol").JsonValue,
): void {
  const route = boundary.eventRoute(event);
  if (!route) {
    return;
  }
  void channel
    .send({
      kind: "native-event",
      route,
      event,
      payload,
    })
    .catch((error) => {
      if (stopping || closingSent || !boundary.matches(route)) {
        return;
      }
      if (error instanceof BunawayError && error.code === "BUSY") {
        boundary.fail(route, {
          code: "BUSY",
          message: "Native event queue full.",
        });
        return;
      }
      fail(error);
    });
}

try {
  // Keep window and WebView COM work on this STA through cleanup.
  hr(ole.symbols.CoInitializeEx(null, 2), "CoInitializeEx(STA)");
  initialized = true;
  adapters = await operations(
    config.plugins ?? [],
    config.dataRoot,
    "ui",
    windowServices,
    packagedPlugins,
  );
  windows = new Windows(
    () => {
      if (closingSent) {
        return;
      }
      closingSent = true;
      channel.notify({
        kind: "closing",
      });
    },
    config.icon,
    config.runtime.id,
    () => channel.poll(),
  );
  if (config.desktop?.tray) {
    tray = new Tray(windows, config.desktop.tray.tooltip, (action) => {
      if (action === "show") {
        visibility("show");
      } else {
        requestQuit("tray");
      }
    });
  }
  if (tray) {
    log("tray-created", {
      hwnd: tray.hwnd.toString(),
    });
  }
  log("ui-thread", {
    pid: process.pid,
    thread: kernel.symbols.GetCurrentThreadId(),
  });
  for (const spec of config.windows) {
    if (spec.startup !== false) {
      createWindow(spec);
    }
  }
  await channel.send({
    kind: "ready",
  });
  while (!stopping) {
    checkCallbacks();
    windows.pump();
    for (const [viewId, view] of views) {
      if (view.pendingClose) {
        view.pendingClose = false;
        if (
          view.forceClose ||
          !closingWindows.has(view.readiness.snapshot().windowId)
        ) {
          void closeWindow(viewId, view.forceClose ? "force" : "close").catch(
            fail,
          );
        }
      }
      if (view.native.failure) {
        view.readiness?.terminate({
          code: "INTERNAL",
          message: "WebView creation failed.",
        });
        throw view.native.failure;
      }
      if (!view.ready && !view.boundary.closed && Date.now() > view.deadline) {
        view.readiness?.terminate({
          code: "TIMEOUT",
          message: "WebView creation timed out.",
        });
        throw new Error("WebView startup timed out");
      }
      if (!view.boundary.closed && Date.now() > view.documentDeadline) {
        view.readiness?.expireDocument();
      }
      if (!view.boundary.closed && Date.now() > view.sdkDeadline) {
        view.readiness?.expireSdk();
      }
      view.boundary.scanDeadlines();
      cleanupView(view);
    }
    if (
      !closingSent &&
      !adapters?.busy() &&
      [
        ...views.values(),
      ].every((view) => view.boundary.closed)
    ) {
      closingSent = true;
      channel.notify({
        kind: "closing",
      });
    }
    if (failure) {
      throw failure;
    }
    // ponytail: bounded polling adds up to 5 ms latency; replace only after measuring idle CPU.
    await Bun.sleep(5);
  }
} catch (error) {
  failure ??= error;
  log("ui-failed", {
    message: String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  channel.notify({
    kind: "fatal",
    error: {
      code: "INTERNAL",
      message: `Windows UI failed: ${String(error).slice(0, 1024)}`,
    },
  });
} finally {
  stopping = true;
  for (const controller of operationControllers.values()) {
    controller.abort();
  }
  uiCalls.clear();
  approved.clear();
  for (const view of views.values()) {
    relations.markClosing(view.readiness.snapshot().windowId);
    view.boundary.revoke("shutdown");
    view.readiness?.terminate({
      code: "CANCELLED",
      message: "App shutdown.",
    });
    view.boundary.closed = true;
    view.native.requestClose();
  }
  const deadline = Date.now() + 35000;
  try {
    // Cleanup can wait for STA callbacks and child-process exit events.
    while (
      [
        ...views.values(),
      ].some((view) => !view.cleaned)
    ) {
      assert(Date.now() < deadline, "STA cleanup timed out");
      windows?.pump();
      for (const view of views.values()) {
        cleanupView(view);
      }
      await Bun.sleep(5);
    }
    tray?.dispose();
    tray = undefined;
    const calls = callbackCalls();
    for (let count = 0; count < 10; count++) {
      windows?.pump();
      await Bun.sleep(5);
    }
    assert.deepEqual(callbackCalls(), calls, "Invoke after native detach");
    log("callbacks-quiescent");
    log("callback-references", disposeCom());
    await disposeAll([
      () => adapters?.dispose(),
      () => {
        windows?.dispose();
        if (initialized) {
          ole.symbols.CoUninitialize();
        }
        // Close COM and Win32 DLL handles after releasing their native owners.
        disposeWin32Bindings();
      },
    ]);
    await channel.drain();
    if (!failure) {
      await channel.send({
        kind: "cleaned",
      });
    }
  } catch (error) {
    failure ??= error;
  }
  channel.close();
  parentPort.close();
}
if (failure) {
  throw failure;
}
