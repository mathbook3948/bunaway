import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import type { ShutdownReason } from "@bunaway/core";
import { COINIT_APARTMENTTHREADED, checkHresult } from "@bunaway/plugin/win32";
import type {
  NativeTrayOwner,
  WindowLifecycleEvent,
  WindowReadiness,
} from "@bunaway/plugin-api/native";
import {
  API_LIMITS,
  BunawayError,
  type HostContext,
  type HostResponse,
  type Policy,
  resolveMaxPending,
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
import { composePolledObservers } from "../../host-api/bun/polled-observers.ts";
import { AppearanceWindows } from "./appearance.ts";
import {
  Channel,
  type Packet,
  type UIConfig,
  type WindowSpec,
} from "./channel.ts";
import { type CloseDecision, CloseRequests } from "./close-request.ts";
import { callbackCalls, checkCallbacks, disposeCom } from "./com.ts";
import { createTitleCoalescer, limitDocumentTitle } from "./document-title.ts";
import { DownloadCleanupError, DownloadCleanupRetries } from "./downloads.ts";
import { isWindowRole, runWindowRole } from "./menu-window-role.ts";
import { isMonitorChangeMessage, MonitorTracker } from "./monitor-events.ts";
import { monitorServices, windowMonitor } from "./monitors.ts";
import { createSessionMessageHandler } from "./session-end.ts";
import { createSessionNotifications } from "./session-notifications.ts";
import { publishSystemEvent, SystemEvents } from "./system-events.ts";
import {
  advance,
  INITIAL_UI_PHASE,
  isShutdownCommitted,
  type UiEvent,
  type UiPhase,
} from "./ui-phase.ts";
import { originOf, WebView } from "./webview.ts";
import { Windows } from "./win32.ts";
import { disposeWin32Bindings, kernel, ole } from "./win32-bindings.ts";
import {
  WM_CLOSE,
  WM_ENTERSIZEMOVE,
  WM_EXITSIZEMOVE,
  WM_SIZE,
} from "./win32-constants.ts";
import {
  appCommandName,
  contextMenuPoint,
  isSystemMenuArea,
  WM_APPCOMMAND,
  WM_COMMAND,
  WM_CONTEXTMENU,
  webViewKeyMessage,
} from "./window-input-events.ts";
import { WindowLifecycle } from "./window-lifecycle.ts";
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
/** The thread's lifecycle as one value; `ui-phase.ts` lists every transition. */
let phase: UiPhase = INITIAL_UI_PHASE;
const move = (event: UiEvent) => {
  phase = advance(phase, event);
};
const stopping = () => phase.kind === "stopping";
const shutdownCommitted = () => isShutdownCommitted(phase);
/** Stopping or committed: no close request, quit request, lifecycle event or visibility change may start. */
const closing = () => phase.kind !== "live";
const quitPending = () => phase.quit === "pending";
const startRequested = () => phase.start !== "booting";
let initialized = false;
let windows: Windows | undefined;
let systemEvents: SystemEvents | undefined;
const appearanceWindows = new AppearanceWindows();
let adapters: Awaited<ReturnType<typeof operations>> | undefined;
let tray: NativeTrayOwner | undefined;
/** Registers the declared tray again; set once the tray adapter has created the first icon. */
let spawnTray: (() => NativeTrayOwner) | undefined;
type MenuListener = {
  receive(message: number, wparam: bigint, lparam: bigint): void;
  closing(): void;
};
const menuListeners = new Map<string, Set<MenuListener>>();
/** Close plugin-owned menus before Windows can destroy the associated native handles. */
function closeWindowMenus(windowId: string) {
  for (const listener of [
    ...(menuListeners.get(windowId) ?? []),
  ]) {
    listener.closing();
  }
  menuListeners.delete(windowId);
}
/** Deliver a window message, or a key the page left unhandled, to the menus attached to the view's window. */
function dispatchMenuMessage(
  instanceKey: string,
  message: number,
  wparam: bigint,
  lparam: bigint,
) {
  const owner = menuListeners.size ? views.get(instanceKey) : undefined;
  if (owner && !owner.lifecycle.closed) {
    for (const listener of [
      ...(menuListeners.get(owner.readiness.snapshot().windowId) ?? []),
    ]) {
      listener.receive(message, wparam, lparam);
    }
  }
}
const trayListeners = new Set<
  (event: import("@bunaway/plugin-api/native").NativeTrayEvent) => void
>();
/** Resolve the configured host-owned tray without creating an alternate residency path. */
function requireTray(): NativeTrayOwner {
  if (!tray) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "The app has no configured tray.",
    });
  }
  return tray;
}
/**
 * A resident app needs an HWND for the CLI's private shutdown message, even before its first view.
 * With a declared tray the tray window serves, so this runs for tray-less apps and after removal.
 */
function ensureControlWindow() {
  if (controlWindow) {
    return;
  }
  assert(windows);
  controlWindow = windows.create(config.runtime.id, 200, 200, () => {}, false);
  log("desktop-control-created", {
    hwnd: controlWindow.toString(),
  });
}
/**
 * Removes the icon. Removal never ends the app, so it is refused while the icon is what keeps a
 * window-less app running. Hidden windows are the app's responsibility, as with `setVisible`.
 */
function removeTray(): boolean {
  if (!tray) {
    return false;
  }
  if (closing()) {
    throw new BunawayError({
      code: "BUSY",
      message: "The app is shutting down.",
    });
  }
  // The popup loop still uses the tray window and the shell bindings that disposal closes.
  if (tray.popupOpen) {
    throw new BunawayError({
      code: "BUSY",
      message: "The tray cannot be removed while its menu is open.",
    });
  }
  // A window being recreated is still a window: its old view is closed and the new one is not registered yet.
  const hasWindow =
    replacements.size > 0 ||
    [
      ...views.values(),
    ].some((view) => !view.lifecycle.closed);
  if (!hasWindow && config.desktop?.closeBehavior !== "keep-alive") {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "The tray cannot be removed while it keeps the app running.",
    });
  }
  // Take over the shutdown message role before the tray window goes away.
  if (config.desktop?.closeBehavior === "keep-alive") {
    ensureControlWindow();
  }
  // A failed release keeps the owner, so a later call or shutdown retries it.
  tray.dispose();
  tray = undefined;
  log("tray-removed", {});
  return true;
}
/** Registers the declared tray again after `removeTray`. */
function createTray() {
  if (!config.desktop?.tray || !spawnTray) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "The app has no configured tray.",
    });
  }
  if (closing()) {
    throw new BunawayError({
      code: "BUSY",
      message: "The app is shutting down.",
    });
  }
  if (tray) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "The tray already exists.",
    });
  }
  try {
    tray = spawnTray();
  } catch (error) {
    // `retain` may have kept a partly built owner; release it so a retry starts clean.
    try {
      tray?.dispose();
      tray = undefined;
    } catch (cleanup) {
      log("tray-create-cleanup-failed", {
        message: cleanup instanceof Error ? cleanup.message : String(cleanup),
      });
    }
    throw error;
  }
  log("tray-created", {
    hwnd: tray.hwnd.toString(),
  });
}
let controlWindow: bigint | undefined;
let monitorWindow: bigint | undefined;
let monitorTracker: MonitorTracker | undefined;
let showRequested = false;
/**
 * Commit app shutdown once, bypassing user quit veto for explicit destruction or host interruption.
 * Only the first reason is delivered, because the main thread reports a single reason to the app.
 */
function signalClosing(reason: ShutdownReason) {
  if (shutdownCommitted()) {
    return;
  }
  move("commit");
  cancelCloseRequests();
  channel.notify({
    kind: "closing",
    reason,
  });
}
function requestQuit(reason: "last-window" | "tray" | "quit-command") {
  if (closing() || quitPending()) {
    return;
  }
  move("quit-request");
  channel.notify({
    kind: "quit-request",
    reason,
  });
}
let windowsWereLive = false;
let windowsEmptyReported = false;
/**
 * Tells the main thread once per transition to zero live windows while the app stays resident.
 * Windows whose controller is ready (the point where `created` is published) and windows still
 * replacing a live one count as live, so a recreation reports only if the replacement creation
 * fails, and then once. A new (non-replacement) window still being created cannot re-arm the report
 * and one that fails creation stays invisible.
 * A windowless start, a pending recreation, and an app already committed to shutdown never report.
 * Runs on every pump turn so a window that becomes live again re-arms the next report; a window
 * that becomes ready and closes within one turn re-arms through `armWindowsEmpty` at readiness.
 */
function reportWindowsEmpty() {
  const anyLive = [
    ...views.values(),
  ].some((view) => (view.ready || view.replacing) && !view.lifecycle.closed);
  if (anyLive) {
    armWindowsEmpty();
    return;
  }
  const resident = !!tray || config.desktop?.closeBehavior === "keep-alive";
  if (
    !windowsWereLive ||
    windowsEmptyReported ||
    !resident ||
    stopping() ||
    shutdownCommitted() ||
    replacements.size > 0
  ) {
    return;
  }
  windowsEmptyReported = true;
  channel.notify({
    kind: "windows-empty",
  });
}

/** A window is live: the next transition to zero windows is reported again. */
function armWindowsEmpty() {
  windowsWereLive = true;
  windowsEmptyReported = false;
}
function visibility(action: "show" | "hide") {
  if (closing()) {
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
    if (view.lifecycle.closed) {
      continue;
    }
    nativeWindows.show(view.native.hwnd, false);
  }
}

/** Restore live views or create the first declaration after old views and API operations finish. */
function showWindows() {
  if (!showRequested || closing()) {
    return;
  }
  assert(windows);
  const live = config.windows.flatMap((spec) =>
    [
      ...views.values(),
    ].filter(
      (view) => view.boundary.policy.id === spec.view && !view.lifecycle.closed,
    ),
  );
  if (live.length) {
    for (const view of live) {
      windows.showForDesktop(view.native.hwnd);
    }
    showRequested = false;
    return;
  }
  // The pump owns native cleanup. Waiting here also avoids racing windows.create/recreate.
  if (
    adapters?.busy() ||
    [
      ...views.values(),
    ].some((view) => !view.lifecycle.cleanupComplete)
  ) {
    return;
  }
  const first = config.windows[0];
  if (first) {
    createWindow(first);
    const view = [
      ...views.values(),
    ].find(
      (view) =>
        view.boundary.policy.id === first.view && !view.lifecycle.closed,
    );
    assert(view);
    windows.showForDesktop(view.native.hwnd);
  }
  showRequested = false;
}
/** Lifetime transitions of one windowId, as published by the `windows.lifecycle` event. */
type WindowLifecyclePhase = WindowLifecycleEvent["phase"];
type ViewState = {
  key: string;
  startup: boolean;
  lifecycle: WindowLifecycle;
  boundary: ViewBoundary;
  native: WebView;
  ready: boolean;
  /**
   * Creation that replaces a window that was live. It counts as live for windows-empty until its
   * controller is ready or creation fails, so a recreation is not mistaken for an empty app.
   */
  replacing: boolean;
  navigationStarted: boolean;
  replacementCancelled: boolean;
  inputRestoreDeadlineMs?: number;
  downloadCleanupRetries?: DownloadCleanupRetries;
  confirmation: string | null;
  deadline: number;
  documentDeadline: number;
  sdkDeadline: number;
  readiness: WindowReadinessTracker;
  /** Phases already published for this windowId; each is emitted at most once. */
  publishedLifecycle: Set<WindowLifecyclePhase>;
  /** The `windows.closeRequested` question this window lifetime may have pending. */
  closeRequests: CloseRequests;
};
const views = new Map<string, ViewState>();
const lifecycleListeners = new Set<(event: WindowLifecycleEvent) => void>();
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
 * Detach a closing view's native references and destroy its HWND.
 * Returns false when cleanup resumes on a later pass: the controller is not detached yet, or a
 * recoverable download cleanup failure keeps this closed owner's references while other views continue.
 */
function detachClosingView(view: ViewState, windowId: string): boolean {
  if (
    view.downloadCleanupRetries &&
    !view.downloadCleanupRetries.canAttempt(
      stopping() || view.native.isBrowserUnavailable(),
    )
  ) {
    return false;
  }
  try {
    if (!view.native.detach()) {
      return false;
    }
  } catch (error) {
    if (!(error instanceof DownloadCleanupError)) {
      throw error;
    }
    const retries =
      view.downloadCleanupRetries ??
      new DownloadCleanupRetries(WINDOW_CLEANUP_TIMEOUT_MS);
    view.downloadCleanupRetries = retries;
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
    return false;
  }
  if (view.downloadCleanupRetries) {
    log("download-cleanup-recovered", {
      windowId,
      attempts: view.downloadCleanupRetries.attempts,
    });
    delete view.downloadCleanupRetries;
  }
  closeWindowMenus(windowId);
  appearanceWindows.detach(windowId);
  windows?.destroy(view.native.hwnd);
  view.lifecycle.detached();
  return true;
}
/**
 * Release a finished view's window relations and publish its destruction.
 * Returns false while input restoration retries within its deadline; past the deadline the restore
 * error is rethrown.
 */
function releaseFinishedView(view: ViewState, windowId: string): boolean {
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
    return false;
  }
  modalWindows.delete(windowId);
  view.lifecycle.released();
  publishLifecycle(view, "destroyed");
  return true;
}
/**
 * Defer detach while WebView creation is pending.
 * Destroy its HWND before finishing COM cleanup.
 */
function cleanupView(view: ViewState) {
  if (!view.lifecycle.closed || view.lifecycle.cleanupComplete) {
    return;
  }
  if (view.lifecycle.phase === "released") {
    view.lifecycle.settleProfile(replacements.has(view.key), () => true);
    return;
  }
  const windowId = view.readiness.snapshot().windowId;
  if (!relations.canRelease(windowId)) {
    return;
  }
  if (
    view.lifecycle.phase === "closing" &&
    !detachClosingView(view, windowId)
  ) {
    return;
  }
  if (view.lifecycle.phase === "detached") {
    if (!view.native.finish()) {
      return;
    }
    view.lifecycle.finished();
  }
  if (
    view.lifecycle.phase === "finished" &&
    !releaseFinishedView(view, windowId)
  ) {
    return;
  }
  view.lifecycle.settleProfile(replacements.has(view.key), () => true);
}
/** Cancel profile retention while leaving already completed native cleanup intact. */
function cancelReplacement(key: string) {
  replacements.delete(key);
  views.get(key)?.lifecycle.cancelReplacement();
}
/** Shutdown turns every pending replacement into final profile cleanup. */
function cancelReplacements() {
  for (const key of replacements.keys()) {
    cancelReplacement(key);
  }
}
// One app-configured limit sizes every pending-request queue on this side of the Workers.
const maxPending = resolveMaxPending(config.policy);
const windowRequests = new NativeRequests(maxPending);
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
  move("stop");
};
// Observers only record intent; normal packet dispatch and native cleanup remain deferred.
const modalCancellationObservers = new Set<(packet: Packet) => void>();
let modalShutdownRequested = false;
type PacketOf<Kind extends Packet["kind"]> = Extract<
  Packet,
  {
    kind: Kind;
  }
>;
/** Permissions and source label that bound what a context may ask the host to do. */
function authorizationFor(context: HostContext) {
  if (context === config.backendContext) {
    return {
      permissions: config.policy.backend,
      source: "backend",
    };
  }
  const view = viewByContext(context);
  return {
    permissions: view?.boundary.policy.host,
    source: `view:${view?.boundary.policy.id ?? "invalid"}`,
  };
}
/** The backend observes window lifecycle phases without a grant; documents never do. */
function isBackendOpenOperation(
  context: HostContext,
  operation: string,
): boolean {
  return (
    context === config.backendContext &&
    operation === "windows.waitForLifecycle"
  );
}
/** An invalid call, a stopping host or a missing permission all deny the request. */
function isOperationAllowed(
  context: HostContext,
  operationCall: PacketOf<"operation">["call"],
  permissions: ReturnType<typeof authorizationFor>["permissions"],
  granted: boolean,
): boolean {
  try {
    const call = registry.validateCall(operationCall);
    return (
      !stopping() &&
      !shutdownCommitted() &&
      granted &&
      !!permissions &&
      (isBackendOpenOperation(context, call.operation) ||
        registry.allowed(permissions, call))
    );
  } catch {
    /* Invalid requests fail closed at the host boundary. */
    return false;
  }
}
function handleShutdown() {
  move("stop");
  cancelReplacements();
  windowRequests.cancelAll();
  approved.clear();
  uiCalls.clear();
  for (const [key, view] of views) {
    commitClose(key, view, "shutdown");
  }
}
function handleSessionFailure(packet: PacketOf<"session-failure">) {
  discardContext(packet.route.context);
  const view = viewByContext(packet.route.context);
  if (view?.boundary.matches(packet.route)) {
    view.boundary.fail(packet.route, packet.error);
  }
}
function handleOperation(packet: PacketOf<"operation">) {
  assert(
    !stopping() && !uiCalls.has(packet.requestId) && uiCalls.size < maxPending,
    "Invalid UI queue request",
  );
  uiCalls.set(packet.requestId, packet);
  channel.notify({
    kind: "prepare",
    context: packet.context,
    requestId: packet.requestId,
    call: packet.call,
  });
}
/** A queued call runs only when the grant matches the context and source that queued it. */
function handleGrant(packet: PacketOf<"grant">) {
  const queued = uiCalls.get(packet.requestId);
  if (!queued) {
    return;
  }
  assert(queued.context === packet.context);
  uiCalls.delete(packet.requestId);
  const { permissions, source } = authorizationFor(packet.context);
  const allowed = isOperationAllowed(
    packet.context,
    queued.call,
    permissions,
    packet.allowed && queued.source === source,
  );
  if (!allowed) {
    log("host-request-denied", {
      operation: queued.call.operation,
    });
  }
  // Acceptance releases channel capacity; the call owns its asynchronous completion.
  void executeWindowRequest(queued, allowed, permissions).catch(fail);
}
function handleAuthorize(packet: PacketOf<"authorize" | "authorize-input">) {
  const { permissions } = authorizationFor(packet.context);
  const allowed = isOperationAllowed(
    packet.context,
    packet.call,
    permissions,
    true,
  );
  if (!allowed) {
    log("host-request-denied", {
      operation: packet.call.operation,
    });
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
}
function handleCancel(packet: PacketOf<"cancel">) {
  if (approved.get(packet.requestId) === packet.context) {
    approved.delete(packet.requestId);
  }
  if (uiCalls.get(packet.requestId)?.context === packet.context) {
    uiCalls.delete(packet.requestId);
  }
  if (windowRequests.context(packet.requestId) === packet.context) {
    windowRequests.cancel(packet.requestId);
  }
}
function handleHostResult(packet: PacketOf<"host-result">) {
  const active = activeContext(packet.context);
  const context = approved.get(packet.requestId);
  approved.delete(packet.requestId);
  if (!stopping() && active && context === packet.context) {
    channel.notify({
      ...packet,
      kind: "host-response",
    });
  }
}
/** Route one packet from the main thread to the handler that owns its kind. */
function handleHostPacket(packet: Packet) {
  switch (packet.kind) {
    case "start":
      move("start");
      startViews();
      return;
    case "desktop-control":
      // A removed tray leaves nothing to restore the windows from, so hiding is ignored.
      if (packet.action === "hide" && !tray) {
        return;
      }
      visibility(packet.action);
      return;
    case "quit-cancelled":
      move("quit-cancelled");
      return;
    case "shutdown-committed":
      // Idempotent: the main thread may repeat it, and a prior closing or session-end already set it.
      // The main thread owns the quit from here on, so a pending request no longer skips the close confirmation.
      move("commit");
      move("quit-cancelled");
      cancelCloseRequests();
      return;
    case "shutdown":
      handleShutdown();
      return;
    case "server":
      viewByContext(packet.route.context)?.boundary.send(
        packet.route,
        packet.message,
      );
      return;
    case "session-failure":
      handleSessionFailure(packet);
      return;
    case "operation":
      handleOperation(packet);
      return;
    case "grant":
      handleGrant(packet);
      return;
    case "authorize":
    case "authorize-input":
      handleAuthorize(packet);
      return;
    case "cancel":
      handleCancel(packet);
      return;
    case "cancel-context":
      discardContext(packet.context);
      return;
    case "host-result":
      handleHostResult(packet);
      return;
    default:
      throw new Error("Unexpected UI packet");
  }
}
const channel = new Channel(
  parentPort,
  config.runtime,
  "ui",
  handleHostPacket,
  fail,
  composePolledObservers(
    (packet) => {
      if (packet.kind === "shutdown") {
        modalShutdownRequested = true;
      }
      for (const observe of modalCancellationObservers) {
        observe(packet);
      }
    },
    (packet) => windowRequests.interruptModal(packet),
  ),
  maxPending,
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
          if (
            shutdownCommitted() ||
            stopping() ||
            !activeContext(queued.context)
          ) {
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
  if (stopping() || !active || !activeContext(queued.context)) {
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
    phase.kind === "stopping" ||
    phase.start === "booting" ||
    (phase.start === "starting" &&
      [
        ...views.values(),
      ].some((view) => !view.ready && !view.lifecycle.closed))
  ) {
    return;
  }
  move("navigate");
  for (const view of views.values()) {
    if (view.ready && !view.lifecycle.closed && !view.navigationStarted) {
      view.navigationStarted = true;
      view.native.navigate();
    }
  }
}
/** Ends every wait on an app close decision, so a shutdown that has begun is never held back by one. */
function cancelCloseRequests() {
  for (const view of views.values()) {
    view.closeRequests.cancel();
  }
}
/**
 * Whether the app has asked to decide this window's user close itself: its current document listens
 * holds a confirmed `windows.closeRequested` subscription and may answer with `windows.respondClose`.
 * A listen that Core has not confirmed yet does not count, since it may still be rejected. Without a
 * subscription the close never waits on an app, and a policy that cannot answer would otherwise wait
 * forever. Ending the last subscription while a request is pending cancels that request and keeps
 * the window open.
 */
function appDecidesClose(view: ViewState): boolean {
  return (
    !quitPending() &&
    !stopping() &&
    !shutdownCommitted() &&
    registry.operations.has("windows.respondClose") &&
    registry.allowed(view.boundary.policy.host, {
      operation: "windows.respondClose",
      payload: {
        view: view.boundary.policy.id,
      },
    }) &&
    view.boundary.subscribed("windows.closeRequested")
  );
}
/**
 * Asks the window's own document whether it may close and waits for the answer.
 * The wait ends only by `respondClose` or a cancellation: revocation or navigation of the document,
 * the document ending its last `windows.closeRequested` subscription, an undeliverable event, forced
 * or shutdown closes and session end. There is no deadline.
 */
function askAppToDecideClose(view: ViewState): Promise<CloseDecision> {
  const { requestId, decision } = view.closeRequests.begin();
  const { windowId, viewId } = view.readiness.snapshot();
  sendNativeEvent(
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
type CloseTarget = {
  id: string;
  viewId: string;
  view: ViewState;
};

/** The window and its descendants in the order they close, each with its view. */
function closeSubtree(windowId: string): CloseTarget[] {
  return relations.closeOrder(windowId).map((id) => {
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
}

/** Retires every window of the subtree; descendants never get a replacement of their own. */
function commitSubtreeClose(view: ViewState, subtree: CloseTarget[]) {
  for (const child of subtree) {
    if (child.view !== view) {
      child.view.replacementCancelled = true;
    }
    commitClose(child.viewId, child.view);
  }
}

/** Forced and destroy closes skip every confirmation and always report the window closed. */
function forceClose(
  view: ViewState,
  subtree: CloseTarget[],
  mode: "force" | "destroy",
): true {
  commitSubtreeClose(view, subtree);
  // Internal failed/cancelled creation preserves residency; public last-window destroy ends the app.
  if (
    mode === "destroy" &&
    [
      ...views.values(),
    ].every((candidate) => candidate.lifecycle.closed)
  ) {
    signalClosing("window-destroyed");
  }
  return true;
}

/** True when a user close of this top-level window only hides it to the tray. */
function closesToTray(windowId: string): boolean {
  return (
    config.desktop?.closeBehavior === "hide" &&
    !!tray &&
    !relations.getParent(windowId)
  );
}

/**
 * Asks the app to decide a user close. "gone" means the document or the app ended meanwhile,
 * and a cancelled request counts as declined because the document that was asked is gone.
 */
async function appCloseApproval(
  view: ViewState,
): Promise<"allowed" | "declined" | "gone"> {
  const decision = await askAppToDecideClose(view);
  if (view.lifecycle.closed || closing()) {
    return "gone";
  }
  return decision === "allow" ? "allowed" : "declined";
}

/**
 * Shows each pending native close confirmation of the subtree. Returns the close result when a
 * confirmation declines or shutdown ends the wait, and undefined when the close may go on.
 */
function confirmSubtreeClose(
  view: ViewState,
  subtree: CloseTarget[],
  mode: "close" | "recreate" | "handoff",
  appApproved: boolean,
): boolean | undefined {
  assert(windows);
  for (const child of subtree) {
    if (
      child.view.lifecycle.closed ||
      !child.view.confirmation ||
      (child.view === view && appApproved) ||
      (mode === "close" && quitPending())
    ) {
      continue;
    }
    log("window-close-confirmation", {
      view: child.viewId,
    });
    if (
      !windows.confirmClose(
        child.view.native.hwnd,
        windows.getTitle(child.view.native.hwnd),
        child.view.confirmation,
      )
    ) {
      return view.lifecycle.closed;
    }
    if (closing() || view.lifecycle.closed) {
      return true;
    }
  }
  return undefined;
}

/** True when closing this subtree leaves no other open window, or a quit is already pending. */
function closesLastWindow(subtree: CloseTarget[]): boolean {
  return (
    config.desktop?.closeBehavior !== "keep-alive" &&
    (quitPending() ||
      [
        ...views.values(),
      ].filter(
        (candidate) =>
          !candidate.lifecycle.closed &&
          !subtree.some((child) => child.view === candidate),
      ).length === 0)
  );
}

/** Requests the last-window quit and waits until it ends this view or is cancelled. */
async function quitForLastWindow(view: ViewState): Promise<boolean> {
  requestQuit("last-window");
  while (
    quitPending() &&
    !view.lifecycle.closed &&
    !stopping() &&
    !shutdownCommitted()
  ) {
    await Bun.sleep(5);
  }
  return view.lifecycle.closed || closing();
}

/**
 * Runs the non-forced checks in order: close to tray, the app's own decision, native
 * confirmations, then the last-window quit. Returns the close result when one of them settles it
 * and undefined when the windows may be retired.
 */
async function decideClose(
  viewId: string,
  view: ViewState,
  subtree: CloseTarget[],
  mode: "close" | "recreate" | "handoff",
): Promise<boolean | undefined> {
  assert(windows);
  const windowId = view.readiness.snapshot().windowId;
  if (mode === "close" && closesToTray(windowId)) {
    assert(tray, "Close to tray requires a tray");
    windows.show(view.native.hwnd, false);
    log("view-window-hidden", {
      view: viewId,
    });
    return false;
  }
  let appApproved = false;
  if (mode === "close" && appDecidesClose(view)) {
    const approval = await appCloseApproval(view);
    if (approval !== "allowed") {
      return approval === "gone";
    }
    appApproved = true;
  }
  const confirmed = confirmSubtreeClose(view, subtree, mode, appApproved);
  if (confirmed !== undefined) {
    return confirmed;
  }
  // Native confirmation pumps messages, so recheck shutdown before committing closure.
  if (view.lifecycle.closed) {
    return true;
  }
  if (mode === "close" && closesLastWindow(subtree)) {
    return quitForLastWindow(view);
  }
  return undefined;
}

/**
 * Handle user close, window recreation, and forced shutdown requests.
 * Returns false if hidden or declined, including a cancelled final quit.
 * A user-style close waits for the target document's `windows.respondClose` when it subscribed to
 * `windows.closeRequested`; the app's approval replaces only the target's own close confirmation.
 */
async function closeWindow(
  viewId: string,
  mode: "close" | "recreate" | "handoff" | "force" | "destroy" = "close",
): Promise<boolean> {
  const view = views.get(viewId);
  assert(view);
  view.lifecycle.takeCloseRequest();
  if (mode === "force" || mode === "destroy") {
    cancelReplacement(viewId);
  }
  // A recreation may have retired this lifetime already; public destroy must still decide app shutdown.
  if (view.lifecycle.closed && mode !== "destroy") {
    return true;
  }
  assert(windows);
  const windowId = view.readiness.snapshot().windowId;
  const subtree = closeSubtree(windowId);
  if (mode === "force" || mode === "destroy") {
    return forceClose(view, subtree, mode);
  }
  if (subtree.some((child) => closingWindows.has(child.id))) {
    throw new BunawayError({
      code: "BUSY",
      message: "Window close is already pending.",
    });
  }
  for (const child of subtree) {
    closingWindows.add(child.id);
  }
  try {
    const settled = await decideClose(viewId, view, subtree, mode);
    if (settled !== undefined) {
      return settled;
    }
    if (mode === "recreate") {
      replacements.set(viewId, {
        parent: relations.getParent(windowId)?.windowId ?? null,
        modal: modalWindows.has(windowId),
      });
    }
    commitSubtreeClose(view, subtree);
    return true;
  } finally {
    for (const child of subtree) {
      closingWindows.delete(child.id);
    }
  }
}

/** Retires sessions before native release. The cleanup pump releases descendants first. */
function commitClose(
  viewId: string,
  view: ViewState,
  reason: "closing" | "shutdown" = "closing",
) {
  // A forced, recreated or shutdown close ends any wait on the app before the sessions are revoked.
  view.closeRequests.cancel();
  if (!view.lifecycle.commitClose()) {
    return;
  }
  closeWindowMenus(view.readiness.snapshot().windowId);
  relations.markClosing(view.readiness.snapshot().windowId);
  view.boundary.revoke(reason);
  view.readiness?.terminate({
    code: "CANCELLED",
    message: reason === "shutdown" ? "App shutdown." : "Window closed.",
  });
  // The boundary keeps its own document gate; native retirement is owned by the lifecycle.
  view.boundary.closed = true;
  view.native.requestClose();
  if (reason === "closing") {
    publishLifecycle(view, "closed");
    log("view-window-closed", {
      view: viewId,
    });
  }
}
const windowServices: import("@bunaway/plugin-api/native").NativeWindowServices =
  {
    specs: config.windows,
    appearance: appearanceWindows,
    monitors: {
      ...monitorServices,
      snapshot() {
        assert(monitorTracker, "Monitor tracking is unavailable.");
        return monitorTracker.snapshot();
      },
    },
    supportsCreationOptions: true,
    validateCreation: (spec) => {
      assert(windows);
      windows.validateCreation(spec.window);
    },
    onLifecycle(listener) {
      lifecycleListeners.add(listener);
      return () => {
        lifecycleListeners.delete(listener);
      };
    },
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
            closed: view.lifecycle.closed,
            cleaned:
              view.lifecycle.cleanupComplete &&
              (!replacements.has(viewId) || view.native.canReuseProfile()),
            ready: view.ready,
            failure: view.native.failure,
            replacementCancelled: view.replacementCancelled,
            deadline: view.deadline,
          }
        : undefined;
    },
    create: createWindow,
    creationSettled: cancelReplacement,
    close: (viewId, replacing = true) =>
      closeWindow(viewId, replacing ? "recreate" : "handoff"),
    destroy: (viewId) => closeWindow(viewId, "force"),
    stopping: () => stopping(),
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
        getMonitor: () => windowMonitor(hwnd),
        showPrintUI: (kind) => view.native.showPrintUI(kind),
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
        respondClose(requestId, allow) {
          if (!view.closeRequests.respond(requestId, allow)) {
            throw new BunawayError({
              code: "INVALID_ARGUMENT",
              message: "No pending close request.",
            });
          }
        },
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
        getTitlebar: () => nativeWindows.getTitlebar(hwnd),
        setAlwaysOnTop: (alwaysOnTop) =>
          nativeWindows.setAlwaysOnTop(hwnd, alwaysOnTop),
        isAlwaysOnTop: () => nativeWindows.isAlwaysOnTop(hwnd),
        moveTop: () => nativeWindows.moveTop(hwnd),
        moveToBottom: () => nativeWindows.moveToBottom(hwnd),
        setSkipTaskbar: (skipTaskbar) =>
          nativeWindows.setSkipTaskbar(hwnd, skipTaskbar),
        isSkipTaskbar: () => nativeWindows.isSkipTaskbar(hwnd),
        setContentProtection: (contentProtection) =>
          nativeWindows.setContentProtection(hwnd, contentProtection),
        isContentProtected: () => nativeWindows.isContentProtected(hwnd),
        requestAttention: (mode) => nativeWindows.requestAttention(hwnd, mode),
        cancelAttention: () => nativeWindows.cancelAttention(hwnd),
        setFocusable: (focusable) =>
          nativeWindows.setFocusable(hwnd, focusable),
        isFocusable: () => nativeWindows.isFocusable(hwnd),
        setMinimizable: (minimizable) =>
          nativeWindows.setMinimizable(hwnd, minimizable),
        isMinimizable: () => nativeWindows.isMinimizable(hwnd),
        setMaximizable: (maximizable) =>
          nativeWindows.setMaximizable(hwnd, maximizable),
        isMaximizable: () => nativeWindows.isMaximizable(hwnd),
        setFullscreenable: (fullscreenable) =>
          nativeWindows.setFullscreenable(hwnd, fullscreenable),
        isFullscreenable: () => nativeWindows.isFullscreenable(hwnd),
        setOpacity: (opacity) => nativeWindows.setOpacity(hwnd, opacity),
        getOpacity: () => nativeWindows.getOpacity(hwnd),
        setBackgroundColor(color) {
          // The WebView first, so a rejected color never reaches the window; a failure after the controller accepted it leaves the window color unchanged.
          view.native.setBackgroundColor(color);
          nativeWindows.setBackgroundColor(hwnd, color);
        },
        getBackgroundColor: () => nativeWindows.getBackgroundColor(hwnd),
        setHasShadow: (shadow) => nativeWindows.setHasShadow(hwnd, shadow),
        hasShadow: () => nativeWindows.hasShadow(hwnd),
        setRoundedCorners: (rounded) =>
          nativeWindows.setRoundedCorners(hwnd, rounded),
        hasRoundedCorners: () => nativeWindows.hasRoundedCorners(hwnd),
        setIgnoreMouseEvents: (ignore) =>
          nativeWindows.setIgnoreMouseEvents(hwnd, ignore),
        isIgnoreMouseEvents: () => nativeWindows.isIgnoreMouseEvents(hwnd),
        setClosable: (closable) => nativeWindows.setClosable(hwnd, closable),
        isClosable: () => nativeWindows.isClosable(hwnd),
        setTitle: (title) => nativeWindows.setTitle(hwnd, title),
        getTitle: () => nativeWindows.getTitle(hwnd),
        setAccessibleTitle: (title) =>
          nativeWindows.setAccessibleTitle(hwnd, title),
        getAccessibleTitle: () => nativeWindows.getAccessibleTitle(hwnd),
        setResizable: (resizable) =>
          nativeWindows.setResizable(hwnd, resizable),
        isResizable: () => nativeWindows.isResizable(hwnd),
        startDragging: () => nativeWindows.startDragging(hwnd),
        startResizeDragging: (direction) =>
          nativeWindows.startResizeDragging(hwnd, direction),
        setMovable: (movable) => nativeWindows.setMovable(hwnd, movable),
        isMovable: () => nativeWindows.isMovable(hwnd),
        setAspectRatio: (ratio) => nativeWindows.setAspectRatio(hwnd, ratio),
        getAspectRatio: () => nativeWindows.getAspectRatio(hwnd),
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
        center: (monitorId) => nativeWindows.center(hwnd, monitorId),
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
        setThumbnailClip: (region) =>
          nativeWindows.setThumbnailClip(hwnd, region),
        setThumbnailToolTip: (toolTip) =>
          nativeWindows.setThumbnailToolTip(hwnd, toolTip),
        hasCustomIcon: () => nativeWindows.hasWindowIcon(hwnd),
        setIcon: (icon) => nativeWindows.setWindowIcon(hwnd, icon),
        setOverlayIcon: (icon, description) =>
          nativeWindows.setOverlayIcon(hwnd, icon, description),
        setThumbnailToolbar: (buttons) =>
          nativeWindows.setThumbnailToolbar(hwnd, buttons),
      };
    },
  };
/** Create the HWND and WebView, destroying the HWND if WebView setup fails. */
function createWindow(
  spec: WindowSpec,
  replacingLiveWindow = false,
  instanceKey = spec.view,
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
      viewById(parent.windowId)?.lifecycle.closed ||
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
  const boundary = new ViewBoundary(
    policy,
    {
      origin: originOf,
      source: () => native.source(),
      ready: () => phase.kind === "live" && phase.start === "running",
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
        views
          .get(instanceKey)
          ?.readiness?.sdkComplete(route.documentGeneration),
      subscriptionEnded: (event) => {
        const view = views.get(instanceKey);
        // Without a confirmed listener left, nobody can answer the pending question; a pending or
        // rejected listen does not count. Cancelling keeps the window open and releases its closing
        // reservation through closeWindow's cleanup.
        if (
          event === "windows.closeRequested" &&
          view &&
          !view.boundary.subscribed("windows.closeRequested")
        ) {
          view.closeRequests.cancel();
        }
      },
      revoked: (reason, generation, error) => {
        const view = views.get(instanceKey);
        if (!view) {
          return;
        }
        // The question was asked of the revoked document session, which can no longer answer it.
        view.closeRequests.cancel();
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
    },
    maxPending,
  );
  const close = (force = false) => {
    const view = views.get(instanceKey);
    if (view && !view.lifecycle.closed) {
      // Native caption and WebView-requested closes share user policy; renderer failure still retires resources.
      if (!force && windows && !windows.isClosable(view.native.hwnd)) {
        return;
      }
      if (!force && hasPendingClose(view)) {
        return;
      }
      view.lifecycle.requestClose(force);
    }
  };
  const window = windows.create(
    spec.title,
    spec.window.width,
    spec.window.height,
    (message, wparam, lparam) => {
      dispatchMenuMessage(instanceKey, message, wparam, lparam);
      if (isMonitorChangeMessage(message)) {
        monitorTracker?.invalidate();
      }
      if (
        message === WM_APPCOMMAND ||
        message === WM_CONTEXTMENU ||
        message === WM_COMMAND
      ) {
        publishWindowInput(message, wparam, lparam);
      }
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
  /** Input notifications leave the default handling intact and reach only this window's own views. */
  function publishWindowInput(message: number, wparam: bigint, lparam: bigint) {
    // A view is registered only after creation finishes, so input pumped during creation, and
    // input for a closing view, never reaches the bindings below before they are initialized.
    const owner = views.get(instanceKey);
    if (
      stopping() ||
      shutdownCommitted() ||
      !owner ||
      owner.native !== native ||
      owner.lifecycle.closed
    ) {
      return;
    }
    try {
      publishWindowInputEvent(message, wparam, lparam);
    } catch (error) {
      // The notification is best effort; a failure here must not skip DefWindowProc handling.
      log("window-input-event-failed", {
        view: spec.view,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  function publishWindowInputEvent(
    message: number,
    wparam: bigint,
    lparam: bigint,
  ) {
    const { windowId, viewId } = readiness.snapshot();
    if (message === WM_COMMAND) {
      // Only a press on a visible, enabled thumbnail button the app registered becomes an event.
      const buttonId = windows?.thumbnailToolbarButton(window, wparam);
      if (buttonId !== undefined) {
        sendNativeEvent(boundary, "windows.thumbnailToolbarClicked", {
          windowId,
          viewId,
          buttonId,
        });
      }
      return;
    }
    if (message === WM_APPCOMMAND) {
      const command = appCommandName(lparam);
      if (command) {
        sendNativeEvent(boundary, "windows.appCommand", {
          windowId,
          viewId,
          command,
        });
      }
      return;
    }
    const point = contextMenuPoint(lparam);
    // wparam names the window under the pointer; only the frame's own title area qualifies.
    if (!point || wparam !== window) {
      return;
    }
    // DefWindowProc answers the hit test directly; sending the message would re-enter this procedure.
    assert(windows);
    if (isSystemMenuArea(windows.hitTest(window, point.x, point.y))) {
      sendNativeEvent(boundary, "windows.systemContextMenu", {
        windowId,
        viewId,
        ...point,
      });
    }
  }
  windows.observe(window, spec.view, (snapshot, changes) => {
    if (
      stopping() ||
      shutdownCommitted() ||
      views.get(instanceKey)?.native !== native
    ) {
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
      publish: (state) => {
        publishReadiness(state);
        if (state.document === "ready") {
          const current = viewById(state.windowId);
          if (current) {
            publishLifecycle(current, "ready");
          }
        }
      },
      show: () => {
        const current = views.get(instanceKey);
        if (
          current &&
          current.native === native &&
          !current.lifecycle.closed &&
          !stopping() &&
          !shutdownCommitted()
        ) {
          windows?.show(window, true);
        }
      },
    },
  );
  publishReadiness(readiness.snapshot());
  // Record partial HWND ownership before environment creation can fail.
  try {
    appearanceWindows.attach(readiness.snapshot().windowId, window);
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
        key: (kind, virtualKey) => {
          const message = webViewKeyMessage(kind);
          if (message !== undefined && menuListeners.size) {
            // The menu bar resizes the WebView, which must not happen inside its own key callback.
            setTimeout(
              () =>
                dispatchMenuMessage(
                  instanceKey,
                  message,
                  BigInt(virtualKey),
                  0n,
                ),
              0,
            );
          }
        },
        titleChanged: createTitleCoalescer((title, settled) => {
          if (
            stopping() ||
            shutdownCommitted() ||
            views.get(instanceKey)?.native !== native
          ) {
            settled();
            return;
          }
          const { windowId, viewId } = readiness.snapshot();
          sendNativeEvent(
            boundary,
            "windows.documentTitleChanged",
            {
              windowId,
              viewId,
              title: limitDocumentTitle(title),
            },
            undefined,
            settled,
          );
        }),
        documentComplete: (error) =>
          views.get(instanceKey)?.readiness?.documentComplete(error),
        close,
        ready: () => {
          const view = views.get(instanceKey);
          assert(view);
          view.ready = true;
          view.replacing = false;
          // The controller exists now; a retired or replaced lifetime never announces itself.
          if (view.native === native && !view.lifecycle.closed) {
            publishLifecycle(view, "created");
            // Readiness arrives in a microtask after the pump turn that created the window, and a
            // close request can be served by the next turn, so the turn-based scan never sees the
            // window live. Re-arm here so that a short-lived window still reports its transition.
            armWindowsEmpty();
          }
          startViews();
        },
        log: (event, data) =>
          log(event, {
            view: spec.view,
            windowId: readiness.snapshot().windowId,
            ...data,
          }),
      },
      config.legacyProfile,
      config.devtools,
    );
    // Content joins the appearance lifetime after attach, so a theme chosen earlier is replayed.
    const created = native;
    appearanceWindows.bindContent(readiness.snapshot().windowId, (scheme) =>
      created.setColorScheme(scheme),
    );
  } catch (error) {
    readiness.terminate({
      code: "INTERNAL",
      message: "WebView creation failed.",
    });
    appearanceWindows.detach(readiness.snapshot().windowId);
    windows.destroy(window);
    throw error;
  }
  // A new HWND lifetime joins the end of its definition's creation order.
  views.delete(instanceKey);
  views.set(instanceKey, {
    key: instanceKey,
    startup: !startRequested(),
    lifecycle: new WindowLifecycle(),
    readiness,
    boundary,
    native,
    ready: false,
    replacing: replacement !== undefined,
    navigationStarted: false,
    replacementCancelled: false,
    confirmation: null,
    deadline: Date.now() + WINDOW_PREPARATION_TIMEOUT_MS,
    documentDeadline: Date.now() + WINDOW_PREPARATION_TIMEOUT_MS,
    sdkDeadline: Date.now() + WINDOW_PREPARATION_TIMEOUT_MS,
    publishedLifecycle: new Set(),
    closeRequests: new CloseRequests(),
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
    stopping() ||
    shutdownCommitted() ||
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
/**
 * Tell open sessions that may enumerate instances about one lifetime phase of a window.
 * The guard keeps each phase at-most-once per windowId. Shutdown and session end suppress delivery
 * because sessions are being torn down. A closed window's own boundary is already revoked, so it
 * is never a recipient of its own closed or destroyed phase. Every later phase requires `created`,
 * which is published once the WebView controller exists, so a lifetime whose controller never became
 * ready (creation failed or timed out) emits no lifecycle events at all.
 */
function publishLifecycle(view: ViewState, phase: WindowLifecyclePhase): void {
  if (
    stopping() ||
    shutdownCommitted() ||
    view.publishedLifecycle.has(phase) ||
    (phase !== "created" && !view.publishedLifecycle.has("created"))
  ) {
    return;
  }
  view.publishedLifecycle.add(phase);
  const { windowId, viewId } = view.readiness.snapshot();
  // The backend is notified without a grant; documents need the subscription and `windows.getSnapshot`.
  for (const listener of [
    ...lifecycleListeners,
  ]) {
    listener({
      windowId,
      viewId,
      phase,
    });
  }
  if (!registry.operations.has("windows.getSnapshot")) {
    return;
  }
  for (const recipient of views.values()) {
    if (
      !recipient.boundary.eventRoute("windows.lifecycle") ||
      !registry.allowed(recipient.boundary.policy.host, {
        operation: "windows.getSnapshot",
        payload: null,
      })
    ) {
      continue;
    }
    sendNativeEvent(recipient.boundary, "windows.lifecycle", {
      windowId,
      viewId,
      phase,
    });
  }
}
/** Reuse the ordered native-event lane; a lost transition revokes its receiving session. */
function sendNativeEvent(
  boundary: ViewBoundary,
  event: string,
  payload: import("@bunaway/protocol").JsonValue,
  onUndelivered?: () => void,
  onSettled?: () => void,
): void {
  const route = boundary.eventRoute(event);
  if (!route) {
    onUndelivered?.();
    onSettled?.();
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
      onUndelivered?.();
      if (closing() || !boundary.matches(route)) {
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
    })
    .finally(onSettled);
}

/** Gate each recipient before forwarding plugin events through its current live route. */
function publishPluginSystemEvent(
  event: string,
  payload: import("@bunaway/protocol").JsonValue,
  requiredOperation: string,
): void {
  if (closing()) {
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
  checkHresult(
    ole.symbols.CoInitializeEx(null, COINIT_APARTMENTTHREADED),
    "CoInitializeEx(STA)",
  );
  initialized = true;
  windows = new Windows(
    () => signalClosing("interrupted"),
    config.icon,
    config.runtime.id,
    () => channel.poll(),
    createSessionMessageHandler({
      begin(flags, release) {
        // The main thread owns shutdown from here: marking the UI as closing stops new close
        // confirmations and quit requests, and abandons waits for pending ones. A prior
        // signalClosing() reason wins on the main thread, which keeps the first reason.
        move("commit");
        cancelCloseRequests();
        channel.notify({
          kind: "session-end",
          flags,
          release,
        });
      },
      report: log,
    }),
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
    undefined,
    {
      dialogs: {
        watchCancellation(requestId) {
          const context = requestId
            ? windowRequests.context(requestId)
            : undefined;
          let cancelled = modalShutdownRequested;
          const observe = (packet: Packet) => {
            if (
              packet.kind === "shutdown" ||
              (packet.kind === "cancel" &&
                packet.requestId === requestId &&
                packet.context === context) ||
              (packet.kind === "cancel-context" &&
                packet.context === context) ||
              (packet.kind === "session-failure" &&
                packet.route.context === context)
            ) {
              cancelled = true;
            }
          };
          modalCancellationObservers.add(observe);
          return {
            cancelled: () => cancelled,
            dispose: () => {
              modalCancellationObservers.delete(observe);
            },
          };
        },
        origin: (requestId) =>
          windowServices.lookup?.byRequest?.(requestId) ?? null,
        createWindow(receive) {
          assert(windows);
          return windows.create(config.runtime.id, 200, 200, receive, false);
        },
        destroyWindow(hwnd) {
          assert(windows);
          windows.destroy(hwnd);
        },
        owner() {
          const view = [
            ...views.values(),
          ].find(
            (view) =>
              !view.lifecycle.closed &&
              windows?.isVisible(view.native.hwnd) === true,
          );
          if (!view) {
            return null;
          }
          return {
            hwnd: view.native.hwnd,
            alive: () => !view.lifecycle.closed,
          };
        },
        poll: () => channel.poll(),
        stopping: () => closing() || modalShutdownRequested,
      },
      shortcuts: {
        createWindow(receive) {
          assert(windows);
          return windows.create(config.runtime.id, 200, 200, receive, false);
        },
        destroyWindow(hwnd) {
          assert(windows);
          windows.destroy(hwnd);
        },
        emit(event, payload) {
          if (closing()) {
            return;
          }
          for (const view of views.values()) {
            sendNativeEvent(view.boundary, event, payload);
          }
        },
      },
      tray: {
        initialize(create) {
          if (!config.desktop?.tray) {
            return;
          }
          assert(windows);
          assert(!tray, "Tray initialized twice");
          const nativeWindows = windows;
          const trayOptions = config.desktop.tray;
          spawnTray = () =>
            create({
              windows: {
                icon: nativeWindows.icon,
                create: (title, width, height, receive) =>
                  nativeWindows.create(title, width, height, receive, false),
                destroy: (hwnd) => nativeWindows.destroy(hwnd),
                interrupt: (signal, cancel) =>
                  windowRequests.onModalInterrupt(signal, cancel),
              },
              tooltip: trayOptions.tooltip,
              ...(trayOptions.icon === undefined
                ? {}
                : {
                    icon: trayOptions.icon,
                    resources: config.appMetadata.paths?.resources,
                  }),
              retain(owner) {
                tray = owner;
              },
              receive(action) {
                if (action === "show") {
                  visibility("show");
                } else {
                  requestQuit("tray");
                }
              },
              notify(event) {
                for (const receive of trayListeners) {
                  receive(event);
                }
              },
            });
          tray = spawnTray();
        },
        remove() {
          return removeTray();
        },
        create() {
          createTray();
        },
        get: () => tray?.get() ?? null,
        getBounds: () => tray?.getBounds() ?? null,
        setTooltip(tooltip) {
          requireTray().setTooltip(tooltip);
        },
        setIcon(ico) {
          requireTray().setIcon(ico);
        },
        setClickBehavior(showOnLeftClick, menuOnRightClick) {
          requireTray().setClickBehavior(showOnLeftClick, menuOnRightClick);
        },
        setVisible(visible) {
          requireTray().setVisible(visible);
        },
        focus: () => requireTray().focus(),
        popUpContextMenu: (position, signal) =>
          requireTray().popUpContextMenu(position, signal),
        subscribe(receive) {
          trayListeners.add(receive);
          return () => {
            trayListeners.delete(receive);
          };
        },
        emit(event, payload) {
          if (closing()) {
            return;
          }
          for (const view of views.values()) {
            sendNativeEvent(view.boundary, event, payload);
          }
        },
      },
      menus: {
        windows: {
          current() {
            const view = [
              ...views.values(),
            ].find((view) => !view.lifecycle.closed);
            if (!view || stopping()) {
              throw new BunawayError({
                code: "INVALID_ARGUMENT",
                message: "Window is not open.",
              });
            }
            return view.readiness.snapshot().windowId;
          },
          resolve(windowId) {
            const view = viewById(windowId);
            if (!view || view.lifecycle.closed || stopping()) {
              throw new BunawayError({
                code: "INVALID_ARGUMENT",
                message: "Window lifetime is unavailable.",
              });
            }
            return view.native.hwnd;
          },
          subscribe(windowId, receive, closing) {
            const listeners =
              menuListeners.get(windowId) ?? new Set<MenuListener>();
            const listener = {
              receive,
              closing,
            };
            listeners.add(listener);
            menuListeners.set(windowId, listeners);
            return () => {
              listeners.delete(listener);
              if (!listeners.size) {
                menuListeners.delete(windowId);
              }
            };
          },
          interrupt: (signal, cancel) =>
            windowRequests.onModalInterrupt(signal, cancel),
          executeRole(windowId, role) {
            const view = viewById(windowId);
            if (!view || view.lifecycle.closed || stopping()) {
              log("menu-role-skipped", {
                role,
                reason: stopping() ? "host-stopping" : "window-closed",
              });
              return;
            }
            if (isWindowRole(role)) {
              // These take the paths of the caption buttons and the tray's Quit, so the close
              // policy, close requests and quit confirmation still apply.
              runWindowRole(role, {
                requestClose: () => windows?.requestClose(view.native.hwnd),
                minimizable: () =>
                  windows?.isMinimizable(view.native.hwnd) ?? false,
                minimize: () => windows?.minimize(view.native.hwnd),
                requestQuit: () => requestQuit("quit-command"),
                failed: (reason) =>
                  log("menu-role-failed", {
                    role,
                    reason,
                  }),
                skipped: (reason) =>
                  log("menu-role-skipped", {
                    role,
                    reason,
                  }),
              });
              return;
            }
            try {
              const started = view.native.executeEditCommand(role, {
                focusFailed: (reason) =>
                  log("menu-role-focus-failed", {
                    role,
                    reason,
                  }),
                failed: (reason) =>
                  log("menu-role-failed", {
                    role,
                    reason,
                  }),
                skipped: (reason) =>
                  log("menu-role-skipped", {
                    role,
                    reason,
                  }),
              });
              if (!started) {
                log("menu-role-skipped", {
                  role,
                  reason: "webview-unavailable",
                });
              }
            } catch (error) {
              // Menu selection is user input: a failed MoveFocus or protocol start is logged, not thrown.
              log("menu-role-failed", {
                role,
                reason: error instanceof Error ? error.message : String(error),
              });
            }
          },
          changed(windowId) {
            const view = viewById(windowId);
            if (view && !view.lifecycle.closed) {
              try {
                view.native.resize();
                windows?.getSnapshot(view.native.hwnd);
              } catch (error) {
                // Native SetMenu has committed. Report host failure without rolling back plugin state alone.
                fail(error);
              }
            }
          },
        },
        setTrayMenu(items, selected) {
          // Detaching has nothing to do once the declared tray is gone, whether removed or at
          // shutdown. An app that never declared a tray still gets the configuration error.
          if (!items && !tray && (spawnTray || stopping())) {
            return;
          }
          if (!tray) {
            throw new BunawayError({
              code: "UNSUPPORTED",
              message: "The app has no configured tray.",
            });
          }
          tray.setMenu(items, selected);
        },
        emit(event, payload) {
          if (closing()) {
            return;
          }
          for (const view of views.values()) {
            sendNativeEvent(view.boundary, event, payload);
          }
        },
      },
    },
  );
  if (registry.operations.has("windows.getMonitorSnapshot")) {
    monitorTracker = new MonitorTracker(
      monitorServices.list,
      (change) => {
        if (closing()) {
          return;
        }
        for (const recipient of views.values()) {
          if (
            registry.allowed(recipient.boundary.policy.host, {
              operation: "windows.getMonitorSnapshot",
              payload: null,
            })
          ) {
            sendNativeEvent(recipient.boundary, "windows.monitorsChanged", {
              ...change,
            });
          }
        }
      },
      (error) =>
        log("monitor-query-failed", {
          message: String(error),
        }),
    );
    // The initial observation is recovery state, never an event or event history.
    monitorTracker.snapshot();
    if (
      config.policy.views.some(
        (view) =>
          view.events.includes("windows.monitorsChanged") &&
          view.host.permissions.includes("windows.getMonitorSnapshot"),
      )
    ) {
      monitorWindow = windows.create(
        "Bunaway display notifications",
        200,
        200,
        (message) => {
          if (isMonitorChangeMessage(message)) {
            monitorTracker?.invalidate();
          }
        },
        false,
      );
    }
  }
  for (const spec of config.windows) {
    if (spec.startup !== false) {
      windows.validateCreation(spec.window);
    }
  }
  if (config.desktop?.tray && !tray) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message:
        "desktop.tray requires installing and registering @bunaway/plugin-tray.",
    });
  }
  if (!config.desktop?.tray && config.desktop?.closeBehavior === "keep-alive") {
    ensureControlWindow();
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
  while (!stopping()) {
    checkCallbacks();
    windows.pump();
    monitorTracker?.flush();
    systemEvents.flush();
    showWindows();
    for (const [viewId, view] of views) {
      // Controller errors also queue a forced close. Report startup failure before
      // that close retires the boundary and makes the failure look like normal exit.
      if (view.native.failure && !view.lifecycle.closed) {
        const error = view.native.failure;
        view.readiness?.terminate(
          error instanceof BunawayError && error.code === "UNSUPPORTED"
            ? {
                code: error.code,
                message: error.message,
              }
            : {
                code: "INTERNAL",
                message: "WebView creation failed.",
              },
        );
        if (view.startup) {
          throw view.native.failure;
        }
        void closeWindow(viewId, "force").catch(fail);
      }
      const closeRequest = view.lifecycle.takeCloseRequest();
      if (
        closeRequest &&
        (closeRequest === "forced" || !hasPendingClose(view))
      ) {
        void closeWindow(
          viewId,
          closeRequest === "forced" ? "force" : "close",
        ).catch(fail);
      }
      if (!view.ready && !view.lifecycle.closed && Date.now() > view.deadline) {
        log("webview-creation-timeout", {
          view: view.boundary.policy.id,
          windowId: view.readiness?.snapshot().windowId,
          ...view.native.creationSnapshot(),
          ready: view.ready,
          startRequested: startRequested(),
          startup: view.startup,
          lifecycle: view.lifecycle.phase,
          deadlineLateMs: Date.now() - view.deadline,
        });
        view.readiness?.terminate({
          code: "TIMEOUT",
          message: "WebView creation timed out.",
        });
        if (view.startup) {
          throw new Error("WebView startup timed out");
        }
        void closeWindow(viewId, "force").catch(fail);
      }
      if (!view.lifecycle.closed && Date.now() > view.documentDeadline) {
        view.readiness?.expireDocument();
      }
      if (!view.lifecycle.closed && Date.now() > view.sdkDeadline) {
        view.readiness?.expireSdk();
      }
      view.boundary.scanDeadlines();
      cleanupView(view);
    }
    if (
      !shutdownCommitted() &&
      !tray &&
      config.desktop?.closeBehavior !== "keep-alive" &&
      !adapters?.busy() &&
      [
        ...views.values(),
      ].every((view) => view.lifecycle.closed)
    ) {
      signalClosing("window-destroyed");
    }
    reportWindowsEmpty();
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
    error:
      error instanceof BunawayError
        ? {
            code: error.code,
            message: error.message.slice(0, 1024),
          }
        : {
            code: "INTERNAL",
            message: `Windows UI failed: ${String(error).slice(0, 1024)}`,
          },
  });
} finally {
  move("stop");
  cancelReplacements();
  windowRequests.cancelAll();
  uiCalls.clear();
  approved.clear();
  for (const [key, view] of views) {
    commitClose(key, view, "shutdown");
  }
  const deadline = Date.now() + WINDOW_CLEANUP_TIMEOUT_MS;
  try {
    // Cleanup can wait for STA callbacks and child-process exit events.
    while (
      [
        ...views.values(),
      ].some((view) => !view.lifecycle.cleanupComplete)
    ) {
      assert(Date.now() < deadline, "STA cleanup timed out");
      windows?.pump();
      for (const view of views.values()) {
        cleanupView(view);
      }
      await Bun.sleep(5);
    }
    const disposeTray = () => {
      tray?.dispose();
      tray = undefined;
    };
    for (const dispose of [
      disposeTray,
      () => {
        if (monitorWindow) {
          windows?.destroy(monitorWindow);
          monitorWindow = undefined;
        }
      },
      () => {
        if (controlWindow) {
          windows?.destroy(controlWindow);
          controlWindow = undefined;
        }
      },
    ]) {
      try {
        dispose();
      } catch (error) {
        // A tray release failure must not bypass callback quiescence and other safe cleanup.
        failure ??= error;
      }
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
      // Retry retained tray resources while their Win32 binding is still open.
      disposeTray,
      () => {
        windows?.dispose();
        if (initialized) {
          ole.symbols.CoUninitialize();
        }
        // Close COM and Win32 DLL handles after releasing their native owners.
        if (!tray) {
          disposeWin32Bindings();
        }
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
