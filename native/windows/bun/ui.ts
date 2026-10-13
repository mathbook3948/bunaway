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
import { NativeRequests } from "../../host-api/bun/native-requests.ts";
import { loadPluginCatalog } from "../../host-api/bun/plugin-catalog.ts";
import {
  disposeAll,
  operations,
  pluginRegistry,
} from "../../host-api/bun/plugins.ts";
import {
  Channel,
  type Packet,
  type UIConfig,
  type WindowSpec,
} from "./channel.ts";
import { callbackCalls, checkCallbacks, disposeCom } from "./com.ts";
import { DownloadCleanupError, DownloadCleanupRetries } from "./downloads.ts";
import { createSessionNotifications } from "./session-notifications.ts";
import { publishSystemEvent, SystemEvents } from "./system-events.ts";
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
import { WindowProfiles } from "./window-profiles.ts";
import { WindowReadinessTracker } from "./window-readiness.ts";
import {
  WindowInputRestoreError,
  WindowRelations,
} from "./window-relations.ts";

const config = workerData as UIConfig;
const WINDOW_PREPARATION_TIMEOUT_MS = 30_000;
const WINDOW_CLEANUP_TIMEOUT_MS = 35_000;
const packagedPlugins = await loadPluginCatalog(config.assets);
const registry = pluginRegistry(config.plugins ?? [], packagedPlugins);
registry.validatePolicy(config.policy);
assert(parentPort);
let failure: unknown;
let stopping = false;
let startupNavigationStarted = false;
let startRequested = false;
let closingSent = false;
let initialized = false;
let windows: Windows | undefined;
let systemEvents: SystemEvents | undefined;
let adapters: Awaited<ReturnType<typeof operations>> | undefined;
let tray: Tray | undefined;
let controlWindow: bigint | undefined;
let showRequested = false;
let quitPending = false;
/** Commit app shutdown once, bypassing user quit veto for explicit destruction or host interruption. */
function signalClosing() {
  if (closingSent) {
    return;
  }
  closingSent = true;
  channel.notify({
    kind: "closing",
  });
}
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
  if (stopping || closingSent) {
    return;
  }
  showRequested = action === "show";
  if (showRequested) {
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
    nativeWindows.show(view.native.hwnd, false);
  }
}

/** Restore live views or create the first declaration after old views and API operations finish. */
function showWindows() {
  if (!showRequested || stopping || closingSent) {
    return;
  }
  assert(windows);
  const live = config.windows.flatMap((spec) =>
    [
      ...views.values(),
    ].filter(
      (view) => view.boundary.policy.id === spec.view && !view.boundary.closed,
    ),
  );
  if (live.length) {
    for (const view of live) {
      windows.focus(view.native.hwnd);
    }
    showRequested = false;
    return;
  }
  // The pump owns native cleanup. Waiting here also avoids racing windows.create/recreate.
  if (
    adapters?.busy() ||
    [
      ...views.values(),
    ].some((view) => !view.cleaned)
  ) {
    return;
  }
  const first = config.windows[0];
  if (first) {
    createWindow(first);
    const view = [
      ...views.values(),
    ].find(
      (view) => view.boundary.policy.id === first.view && !view.boundary.closed,
    );
    assert(view);
    windows.focus(view.native.hwnd);
  }
  showRequested = false;
}
type ViewState = {
  key: string;
  startup: boolean;
  released: boolean;
  boundary: ViewBoundary;
  native: WebView;
  detached: boolean;
  cleaned: boolean;
  ready: boolean;
  navigationStarted: boolean;
  pendingClose: boolean;
  forceClose: boolean;
  replacementCancelled: boolean;
  inputRestoreDeadlineMs?: number;
  downloadCleanupRetries?: DownloadCleanupRetries;
  confirmation: string | null;
  deadline: number;
  documentDeadline: number;
  sdkDeadline: number;
  readiness: WindowReadinessTracker;
};
const views = new Map<string, ViewState>();
const profiles = new WindowProfiles(
  config.dataRoot,
  config.legacyProfile ?? false,
  (event, data) =>
    log(event, {
      ...data,
    }),
);
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

/** Native IDs address an HWND lifetime; contexts address one document session. Neither uses a view-only fallback. */
function viewById(windowId: string): ViewState | undefined {
  return [
    ...views.values(),
  ].find((view) => view.readiness.snapshot().windowId === windowId);
}
function viewByContext(context: HostContext): ViewState | undefined {
  return [
    ...views.values(),
  ].find((view) => view.boundary.active(context));
}
function hwndById(windowId: string): bigint {
  const view = viewById(windowId);
  assert(view, "Unknown native window lifetime");
  return view.native.hwnd;
}

function hasPendingClose(view: ViewState): boolean {
  return relations
    .closeOrder(view.readiness.snapshot().windowId)
    .some((id) => closingWindows.has(id));
}
/**
 * Defer detach while WebView creation is pending.
 * Destroy its HWND before finishing COM cleanup.
 */
function cleanupView(view: ViewState) {
  if (!view.boundary.closed || view.cleaned) {
    return;
  }
  if (view.released) {
    view.cleaned = profiles.release(view.key, replacements.has(view.key));
    return;
  }
  const windowId = view.readiness.snapshot().windowId;
  if (!relations.canRelease(windowId)) {
    return;
  }
  if (!view.detached) {
    if (
      view.downloadCleanupRetries &&
      !view.downloadCleanupRetries.canAttempt(
        stopping || view.native.isBrowserUnavailable(),
      )
    ) {
      return;
    }
    try {
      if (!view.native.detach()) {
        return;
      }
    } catch (error) {
      if (!(error instanceof DownloadCleanupError)) {
        throw error;
      }
      const retries = (view.downloadCleanupRetries ??=
        new DownloadCleanupRetries(WINDOW_CLEANUP_TIMEOUT_MS));
      const phase = retries.failed();
      if (phase) {
        log(`download-cleanup-${phase}`, {
          windowId,
          attempts: retries.attempts,
          message: String(error).slice(0, 1024),
        });
      }
      // This closed owner's native references stay owned. Other views and their cleanup keep running.
      // Exhausted retries remain quarantined until shutdown or observed broker exit.
      return;
    }
    if (view.downloadCleanupRetries) {
      log("download-cleanup-recovered", {
        windowId,
        attempts: view.downloadCleanupRetries.attempts,
      });
      delete view.downloadCleanupRetries;
    }
    windows?.destroy(view.native.hwnd);
    view.detached = true;
  }
  if (view.detached && !view.cleaned) {
    if (view.native.finish()) {
      try {
        relations.release(windowId);
      } catch (error) {
        if (!(error instanceof WindowInputRestoreError)) {
          throw error;
        }
        if (view.inputRestoreDeadlineMs === undefined) {
          view.inputRestoreDeadlineMs = Date.now() + WINDOW_CLEANUP_TIMEOUT_MS;
          log("window-input-restore-retry", {
            view: view.readiness.snapshot().viewId,
            message: error.message,
          });
        }
        if (Date.now() >= view.inputRestoreDeadlineMs) {
          throw error;
        }
        return;
      }
      modalWindows.delete(windowId);
      view.released = true;
      view.cleaned = profiles.release(view.key, replacements.has(view.key));
    }
  }
}
/** Shutdown turns every pending replacement into final cleanup, including already released controllers. */
function cancelReplacements() {
  for (const key of replacements.keys()) {
    const view = views.get(key);
    if (view?.released) {
      view.cleaned = false;
    }
  }
  replacements.clear();
}
const windowRequests = new NativeRequests();
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
  windowRequests.cancelContext(context);
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
      cancelReplacements();
      windowRequests.cancelAll();
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
      viewByContext(packet.route.context)?.boundary.send(
        packet.route,
        packet.message,
      );
    } else if (packet.kind === "session-failure") {
      discardContext(packet.route.context);
      const view = viewByContext(packet.route.context);
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
    } else if (
      packet.kind === "authorize-input" ||
      packet.kind === "authorize" ||
      packet.kind === "grant"
    ) {
      const queued =
        packet.kind === "grant" ? uiCalls.get(packet.requestId) : undefined;
      if (packet.kind === "grant") {
        if (!queued) {
          return;
        }
        assert(queued.context === packet.context);
        uiCalls.delete(packet.requestId);
      }
      const operation = packet.kind === "grant" ? queued : packet;
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
          registry.allowed(permissions, call);
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
        // Acceptance releases channel capacity; the call owns its asynchronous completion.
        void executeWindowRequest(queued, allowed, permissions).catch(fail);
        return;
      }
      // Input permission does not reserve a result slot; execution must be authorized again.
      if (packet.kind === "authorize-input") {
        channel.notify({
          kind: "input-authorized",
          context: packet.context,
          requestId: packet.requestId,
          allowed,
        });
        return;
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
      windowRequests.cancel(packet.requestId);
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

/** Observe plugin completion independently of grant acceptance and discard cancelled results. */
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
  const signal = windowRequests.begin(queued.requestId, queued.context);
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
        signal,
        beforeExecute() {
          // Closing commits locally before the main thread sends cancellation packets.
          if (closingSent || stopping || !activeContext(queued.context)) {
            throw new BunawayError({
              code: "CANCELLED",
              message: "Host call was cancelled.",
            });
          }
        },
      },
    );
    response = hostResponse(() => payload);
  } catch (error) {
    response = hostResponse(() => {
      throw error;
    });
  }
  const active = windowRequests.finish(queued.requestId, signal);
  if (stopping || !active || !activeContext(queued.context)) {
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
  mode: "close" | "recreate" | "handoff" | "force" | "destroy" = "close",
): Promise<boolean> {
  const view = views.get(viewId);
  assert(view);
  const forced = mode === "force" || mode === "destroy";
  view.pendingClose = false;
  if (forced) {
    replacements.delete(viewId);
  }
  // A recreation may have retired this lifetime already; public destroy must still decide app shutdown.
  if (view.boundary.closed && mode !== "destroy") {
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
  if (!forced && subtree.some((child) => closingWindows.has(child.id))) {
    throw new BunawayError({
      code: "BUSY",
      message: "Window close is already pending.",
    });
  }
  if (forced) {
    for (const child of subtree) {
      if (child.view !== view) {
        child.view.replacementCancelled = true;
      }
      commitClose(child.viewId, child.view);
    }
    // Internal failed/cancelled creation preserves residency; public last-window destroy ends the app.
    if (
      mode === "destroy" &&
      [
        ...views.values(),
      ].every((candidate) => candidate.boundary.closed)
    ) {
      signalClosing();
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
        (mode === "close" && quitPending)
      ) {
        continue;
      }
      log("window-close-confirmation", {
        view: child.viewId,
      });
      const childSpec = config.windows.find(
        (candidate) => candidate.view === child.view.boundary.policy.id,
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
      config.desktop?.closeBehavior !== "keep-alive" &&
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
    supportsCreationOptions: true,
    validateCreation: (spec) => {
      assert(windows);
      windows.validateCreation(spec.window);
    },
    instances: () =>
      [
        ...views,
      ].map(([key, view]) => ({
        key,
        identity: {
          windowId: view.readiness.snapshot().windowId,
          viewId: view.boundary.policy.id,
        },
      })),
    lookup: {
      byId: (windowId) => windows?.getById(windowId) ?? null,
      byView: (viewId) => windows?.getByView(viewId) ?? null,
      byRequest: (requestId) => {
        const context = windowRequests.context(requestId);
        const view = context && viewByContext(context);
        return view
          ? {
              windowId: view.readiness.snapshot().windowId,
              viewId: view.boundary.policy.id,
            }
          : null;
      },
      focused: () => windows?.getFocused() ?? null,
      lastActive: () => windows?.getLastActive() ?? null,
    },
    read: (viewId) => {
      const view = views.get(viewId);
      return view
        ? {
            closed: view.boundary.closed,
            cleaned:
              view.cleaned &&
              (!replacements.has(viewId) || view.native.canReuseProfile()),
            ready: view.ready,
            failure: view.native.failure,
            replacementCancelled: view.replacementCancelled,
            deadline: view.deadline,
          }
        : undefined;
    },
    create: createWindow,
    creationSettled: (key) => {
      replacements.delete(key);
      const view = views.get(key);
      // A failed replacement can leave a cleaned old lifetime with a preserved temporary profile.
      if (view?.boundary.closed && view.cleaned) {
        view.cleaned = false;
      }
    },
    close: (viewId, replacing = true) =>
      closeWindow(viewId, replacing ? "recreate" : "handoff"),
    destroy: (viewId) => closeWindow(viewId, "force"),
    stopping: () => stopping,
    cancelled: (id) => windowRequests.context(id) === undefined,
    now: () => Date.now(),
    tick: () => Bun.sleep(5),

    window(viewId) {
      const view = views.get(viewId);
      assert(view);
      assert(windows);
      const nativeWindows = windows;
      const hwnd = view.native.hwnd;
      return {
        downloads: {
          setRequestsEnabled: (enabled) =>
            view.native.downloadOperations().setRequestsEnabled(enabled),
          list: () => view.native.downloadOperations().list(),
          approve: (id) => view.native.downloadOperations().approve(id),
          cancel: (id) => view.native.downloadOperations().cancel(id),
          pause: (id) => view.native.downloadOperations().pause(id),
          resume: (id) => view.native.downloadOperations().resume(id),
          forget: (id) => view.native.downloadOperations().forget(id),
        },
        webview: {
          getState: () => view.native.getState(),
          navigate: (url) => view.native.navigateTo(url),
          reload: () => view.native.reload(),
          stop: () => view.native.stop(),
          goBack: () => view.native.goBack(),
          goForward: () => view.native.goForward(),
          setZoomFactor: (factor) => view.native.setZoomFactor(factor),
          openDevTools: () => view.native.openDevTools(),
        },
        audio: {
          getState: () => view.native.getAudioState(),
          setMuted: (muted) => view.native.setAudioMuted(muted),
        },
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
        destroy: () => closeWindow(viewId, "destroy"),
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
        setResizable: (resizable) =>
          nativeWindows.setResizable(hwnd, resizable),
        isResizable: () => nativeWindows.isResizable(hwnd),
        setMovable: (movable) => nativeWindows.setMovable(hwnd, movable),
        isMovable: () => nativeWindows.isMovable(hwnd),
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
        center: () => nativeWindows.center(hwnd),
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
        setTaskbarProgress: (progress) =>
          nativeWindows.setTaskbarProgress(hwnd, progress),
      };
    },
  };
/** Create the HWND and WebView, destroying the HWND if WebView setup fails. */
function createWindow(
  spec: WindowSpec,
  replacingLiveWindow = false,
  instanceKey = spec.instances === "multiple"
    ? `instance-${crypto.randomUUID()}`
    : spec.view,
) {
  assert(windows);
  const replacement = replacingLiveWindow
    ? replacements.get(instanceKey)
    : undefined;
  replacements.delete(instanceKey);
  if (replacement?.parent) {
    const parent = windows.getById(replacement.parent);
    if (
      !parent ||
      viewById(parent.windowId)?.boundary.closed ||
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
      const view = views.get(instanceKey);
      if (view) {
        view.sdkDeadline = Date.now() + API_LIMITS.handshakeTimeoutMs;
        view.readiness?.sessionOpened(route.documentGeneration);
      }
    },
    sdkReady: (route) =>
      views.get(instanceKey)?.readiness?.sdkComplete(route.documentGeneration),
    revoked: (reason, generation, error) => {
      const view = views.get(instanceKey);
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
    const view = views.get(instanceKey);
    if (view && !view.boundary.closed) {
      if (!force && hasPendingClose(view)) {
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
    if (stopping || closingSent || views.get(instanceKey)?.native !== native) {
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
        const current = views.get(instanceKey);
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
          views.get(instanceKey)?.readiness?.documentComplete(error),
        close,
        ready: () => {
          const view = views.get(instanceKey);
          assert(view);
          view.ready = true;
          startViews();
        },
        log: (event, data) =>
          log(event, {
            view: spec.view,
            ...data,
            ...(event === "view-cleaned"
              ? {
                  windowId: readiness.snapshot().windowId,
                }
              : {}),
          }),
      },
      config.legacyProfile,
      config.devtools,
      profiles.path(spec, instanceKey),
    );
  } catch (error) {
    readiness.terminate({
      code: "INTERNAL",
      message: "WebView creation failed.",
    });
    windows.destroy(window);
    profiles.release(instanceKey, false);
    throw error;
  }
  // A new HWND lifetime joins the end of its definition's creation order.
  views.delete(instanceKey);
  views.set(instanceKey, {
    key: instanceKey,
    startup: !startRequested,
    released: false,
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
  const identity = windows.getById(readiness.snapshot().windowId);
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
      const view = views.get(instanceKey);
      assert(view);
      commitClose(instanceKey, view);
      throw error;
    }
  }
}

/** Broadcast preparation to subscribed live sessions with getReadiness permission. */
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
      !registry.allowed(recipient.boundary.policy.host, {
        operation: "windows.getReadiness",
        payload: {
          view: state.viewId,
        },
      })
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

/** Gate each recipient before forwarding plugin events through its current live route. */
function publishPluginSystemEvent(
  event: string,
  payload: import("@bunaway/protocol").JsonValue,
  requiredOperation: string,
): void {
  if (stopping || closingSent) {
    return;
  }
  publishSystemEvent(
    registry,
    [
      ...views.values(),
    ].map(({ boundary }) => boundary),
    event,
    payload,
    requiredOperation,
    sendNativeEvent,
  );
}

try {
  // Keep window and WebView COM work on this STA through cleanup.
  hr(ole.symbols.CoInitializeEx(null, 2), "CoInitializeEx(STA)");
  initialized = true;
  windows = new Windows(signalClosing, config.icon, config.runtime.id, () =>
    channel.poll(),
  );
  let notificationWindow: bigint | undefined;
  let sessionNotifications:
    | ReturnType<typeof createSessionNotifications>
    | undefined;
  systemEvents = new SystemEvents({
    open: (receive) => {
      assert(windows);
      const owner = windows;
      const hwnd = owner.create(
        "Bunaway system notifications",
        200,
        200,
        receive,
        false,
      );
      notificationWindow = hwnd;
      let destroyed = false;
      return () => {
        if (destroyed) {
          return;
        }
        try {
          sessionNotifications?.dispose();
        } finally {
          owner.destroy(hwnd);
          destroyed = true;
          notificationWindow = undefined;
          sessionNotifications?.detached();
          sessionNotifications = undefined;
        }
      };
    },
    sessions: (enable) => {
      if (enable) {
        assert(notificationWindow);
        sessionNotifications ??= createSessionNotifications(notificationWindow);
      } else {
        sessionNotifications?.dispose();
        sessionNotifications = undefined;
      }
    },
    publish: publishPluginSystemEvent,
    report: (error) =>
      log("system-event-failed", {
        message: String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }),
  });
  windowServices.systemEvents = systemEvents;
  adapters = await operations(
    config.plugins ?? [],
    config.dataRoot,
    "ui",
    windowServices,
    packagedPlugins,
  );
  for (const spec of config.windows) {
    if (spec.startup !== false) {
      windows.validateCreation(spec.window);
    }
  }
  if (config.desktop?.tray) {
    tray = new Tray(windows, config.desktop.tray.tooltip, (action) => {
      if (action === "show") {
        visibility("show");
      } else {
        requestQuit("tray");
      }
    });
  } else if (config.desktop?.closeBehavior === "keep-alive") {
    // A resident app needs an HWND for the CLI's private shutdown message, even before its first view.
    controlWindow = windows.create(
      config.runtime.id,
      200,
      200,
      () => {},
      false,
    );
    log("desktop-control-created", {
      hwnd: controlWindow.toString(),
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
  profiles.collectOrphans();
  for (const spec of config.windows) {
    if (spec.startup !== false) {
      // Keep the catalog defaults for later creation, but prevent initial ready callbacks from showing.
      const { showWhenReady, ...hiddenSpec } = spec;
      createWindow(
        config.desktop?.startHidden
          ? {
              ...hiddenSpec,
              visible: false,
            }
          : spec,
      );
    }
  }
  await channel.send({
    kind: "ready",
  });
  while (!stopping) {
    checkCallbacks();
    windows.pump();
    systemEvents.flush();
    showWindows();
    for (const [viewId, view] of views) {
      // Controller errors also queue a forced close. Report startup failure before
      // that close retires the boundary and makes the failure look like normal exit.
      if (view.native.failure && !view.boundary.closed) {
        view.readiness?.terminate({
          code: "INTERNAL",
          message: "WebView creation failed.",
        });
        if (view.startup) {
          throw view.native.failure;
        }
        void closeWindow(viewId, "force").catch(fail);
      }
      if (view.pendingClose) {
        view.pendingClose = false;
        if (view.forceClose || !hasPendingClose(view)) {
          void closeWindow(viewId, view.forceClose ? "force" : "close").catch(
            fail,
          );
        }
      }
      if (!view.ready && !view.boundary.closed && Date.now() > view.deadline) {
        view.readiness?.terminate({
          code: "TIMEOUT",
          message: "WebView creation timed out.",
        });
        if (view.startup) {
          throw new Error("WebView startup timed out");
        }
        void closeWindow(viewId, "force").catch(fail);
      }
      if (!view.boundary.closed && Date.now() > view.documentDeadline) {
        view.readiness?.expireDocument();
      }
      if (!view.boundary.closed && Date.now() > view.sdkDeadline) {
        view.readiness?.expireSdk();
      }
      view.boundary.scanDeadlines();
      cleanupView(view);
      if (
        view.cleaned &&
        !replacements.has(viewId) &&
        config.windows.find((spec) => spec.view === view.boundary.policy.id)
          ?.instances === "multiple"
      ) {
        views.delete(viewId);
      }
    }
    if (
      !closingSent &&
      !tray &&
      config.desktop?.closeBehavior !== "keep-alive" &&
      !adapters?.busy() &&
      [
        ...views.values(),
      ].every((view) => view.boundary.closed)
    ) {
      signalClosing();
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
  cancelReplacements();
  windowRequests.cancelAll();
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
  const deadline = Date.now() + WINDOW_CLEANUP_TIMEOUT_MS;
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
    if (controlWindow) {
      windows?.destroy(controlWindow);
      controlWindow = undefined;
    }
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
      () => systemEvents?.dispose(),
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
