import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import {
  API_LIMITS,
  BunawayError,
  type HostContext,
  type HostResponse,
} from "../../../packages/protocol/src/index.ts";
import { ViewBoundary } from "./boundary.ts";
import {
  Channel,
  type Packet,
  type UIConfig,
  type WindowSpec,
} from "./channel.ts";
import { callbackCalls, checkCallbacks, disposeCom } from "./com.ts";
import { hostResponse } from "./host-response.ts";
import {
  disposeAll,
  operations,
  permissionMatcher,
  pluginRegistry,
} from "./plugins.ts";
import { Tray } from "./tray.ts";
import { originOf, WebView } from "./webview.ts";
import {
  disposeWin32Bindings,
  hr,
  kernel,
  ole,
  user,
  Windows,
} from "./win32.ts";

const config = workerData as UIConfig;
const registry = pluginRegistry(config.plugins ?? []);
registry.validatePolicy(config.policy);
const matches = await permissionMatcher(config.plugins ?? []);
assert(parentPort);
let failure: unknown;
let stopping = false;
let starting = false;
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
  for (const view of views.values()) {
    if (view.boundary.closed) {
      continue;
    }
    const mode =
      action === "hide" ? 0 : user.symbols.IsIconic(view.native.hwnd) ? 9 : 5;
    user.symbols.ShowWindow(view.native.hwnd, mode);
    if (action === "show") {
      user.symbols.SetForegroundWindow(view.native.hwnd);
    }
  }
}
const views = new Map<
  string,
  {
    boundary: ViewBoundary;
    native: WebView;
    detached: boolean;
    cleaned: boolean;
    ready: boolean;
    navigated: boolean;
    pendingClose: boolean;
    forceClose: boolean;
    confirmation: string | null;
    deadline: number;
  }
>();
const cancelled = new Set<string>();
const windowRequests = new Map<string, HostContext>();
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
  async (packet: Packet) => {
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
      approved.clear();
      uiCalls.clear();
      for (const view of views.values()) {
        view.boundary.revoke("shutdown");
        view.boundary.closed = true;
        view.native.requestClose();
      }
    } else if (packet.kind === "server") {
      views
        .get(packet.route.viewId)
        ?.boundary.send(packet.route, packet.message);
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
      let allowed = false;
      try {
        const call = registry.validateCall(operation.call);
        allowed =
          !stopping &&
          !closingSent &&
          (packet.kind !== "grant" || packet.allowed) &&
          !!permissions &&
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
        let response: HostResponse;
        windowRequests.set(packet.requestId, packet.context);
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
              requestId: packet.requestId,
              permissions,
            },
          );
          response = hostResponse(() => payload);
        } catch (error) {
          response = hostResponse(() => {
            throw error;
          });
        } finally {
          windowRequests.delete(packet.requestId);
        }
        const wasCancelled = cancelled.delete(packet.requestId);
        if (stopping || wasCancelled || !activeContext(packet.context)) {
          return;
        }
        channel.notify({
          kind: "host-response",
          context: packet.context,
          requestId: packet.requestId,
          response,
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
      if (windowRequests.has(packet.requestId)) {
        cancelled.add(packet.requestId);
      }
    } else if (packet.kind === "cancel-context") {
      discardContext(packet.context);
    } else if (packet.kind === "host-result") {
      const active =
        packet.context === config.backendContext ||
        [
          ...views.values(),
        ].some((view) => view.boundary.active(packet.context));
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
function startViews() {
  if (
    !startRequested ||
    stopping ||
    (!starting &&
      [
        ...views.values(),
      ].some((view) => !view.ready && !view.boundary.closed))
  ) {
    return;
  }
  starting = true;
  for (const view of views.values()) {
    if (view.ready && !view.boundary.closed && !view.navigated) {
      view.navigated = true;
      view.native.navigate();
    }
  }
}
async function closeWindow(
  viewId: string,
  mode: "close" | "recreate" | "force" = "close",
): Promise<boolean> {
  const view = views.get(viewId);
  assert(view);
  view.pendingClose = false;
  if (view.boundary.closed) {
    return true;
  }
  const spec = config.windows.find((spec) => spec.view === viewId);
  assert(spec);
  assert(windows);
  if (mode === "close" && config.desktop?.closeBehavior === "hide") {
    assert(tray, "Close to tray requires a tray");
    windows.show(view.native.hwnd, false);
    log("view-window-hidden", {
      view: viewId,
    });
    return false;
  }
  if (
    mode !== "force" &&
    view.confirmation &&
    (mode === "recreate" || !quitPending)
  ) {
    log("window-close-confirmation", {
      view: viewId,
    });
    if (
      !windows.confirmClose(view.native.hwnd, spec.title, view.confirmation)
    ) {
      return false;
    }
  }
  if (
    mode === "close" &&
    (quitPending ||
      [
        ...views.values(),
      ].filter((view) => !view.boundary.closed).length <= 1)
  ) {
    requestQuit("last-window");
    while (quitPending && !stopping && !closingSent) {
      await Bun.sleep(5);
    }
    return stopping || closingSent;
  }
  view.boundary.revoke("closing");
  view.boundary.closed = true;
  view.native.requestClose();
  log("view-window-closed", {
    view: viewId,
  });
  return true;
}
const windowServices: import("../../../packages/plugin-api/src/native.ts").NativeWindowServices =
  {
    specs: config.windows,
    read: (viewId) => {
      const view = views.get(viewId);
      return view
        ? {
            closed: view.boundary.closed,
            cleaned: view.cleaned,
            ready: view.ready,
            failure: view.native.failure,
            deadline: view.deadline,
          }
        : undefined;
    },
    create: createWindow,
    close: (viewId) => closeWindow(viewId, "recreate"),
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
        show: (visible) => nativeWindows.show(hwnd, visible),
        focus: () => nativeWindows.focus(hwnd),
        close: () => closeWindow(viewId),
        isFullscreen: () => nativeWindows.isFullscreen(hwnd),
        setSize(width, height) {
          nativeWindows.setSize(hwnd, width, height);
          view.native.resize();
        },
        setPosition: (x, y) => nativeWindows.setPosition(hwnd, x, y),
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
function createWindow(spec: WindowSpec) {
  assert(windows);

  const policy = config.policy.views.find((view) => view.id === spec.view);
  assert(policy);
  let native: WebView;
  const boundary = new ViewBoundary(policy, {
    origin: originOf,
    source: () => native.source(),
    ready: () => starting && !stopping && !closingSent,
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
  });
  const close = (force = false) => {
    const view = views.get(spec.view);
    if (view && !view.boundary.closed) {
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
      if (message === 0x10) {
        close();
      } else if (message === 5) {
        native?.resize();
      } else if (message === 0x231) {
        log("modal-enter", {
          view: spec.view,
        });
      } else if (message === 0x232) {
        log("modal-exit", {
          view: spec.view,
        });
      }
    },
  );
  log("window-created", {
    view: spec.view,
    hwnd: window.toString(),
  });
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
    windows.destroy(window);
    throw error;
  }
  views.set(spec.view, {
    boundary,
    native,
    detached: false,
    cleaned: false,
    ready: false,
    navigated: false,
    pendingClose: false,
    forceClose: false,
    confirmation: null,
    deadline: Date.now() + 30000,
  });
}
try {
  hr(ole.symbols.CoInitializeEx(null, 2), "CoInitializeEx(STA)");
  initialized = true;
  adapters = await operations(
    config.plugins ?? [],
    config.dataRoot,
    "ui",
    windowServices,
  );
  windows = new Windows(() => {
    if (closingSent) {
      return;
    }
    closingSent = true;
    channel.notify({
      kind: "closing",
    });
  });
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
        void closeWindow(viewId, view.forceClose ? "force" : "close").catch(
          fail,
        );
      }
      if (view.native.failure) {
        throw view.native.failure;
      }
      if (!view.ready && !view.boundary.closed && Date.now() > view.deadline) {
        throw new Error("WebView startup timed out");
      }
      view.boundary.scanDeadlines();
      if (view.boundary.closed && !view.detached && view.native.detach()) {
        windows.destroy(view.native.hwnd);
        view.detached = true;
      }
      if (view.detached && !view.cleaned) {
        view.cleaned = view.native.finish();
      }
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
  channel.notify({
    kind: "fatal",
    error: {
      code: "INTERNAL",
      message: "Windows UI failed.",
    },
  });
} finally {
  stopping = true;
  uiCalls.clear();
  approved.clear();
  for (const view of views.values()) {
    view.boundary.revoke("shutdown");
    view.boundary.closed = true;
    view.native.requestClose();
  }
  const deadline = Date.now() + 35000;
  try {
    while (
      [
        ...views.values(),
      ].some((view) => !view.cleaned)
    ) {
      assert(Date.now() < deadline, "STA cleanup timed out");
      windows?.pump();
      for (const view of views.values()) {
        if (!view.detached && view.native.detach()) {
          windows?.destroy(view.native.hwnd);
          view.detached = true;
        }
        if (view.detached && !view.cleaned) {
          view.cleaned = view.native.finish();
        }
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
