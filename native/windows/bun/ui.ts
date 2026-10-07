import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import {
  API_LIMITS,
  BunawayError,
  type HostContext,
} from "../../../packages/protocol/src/index.ts";
import { ViewBoundary } from "./boundary.ts";
import { Channel, type Packet, type UIConfig } from "./channel.ts";
import { callbackCalls, checkCallbacks, disposeCom } from "./com.ts";
import { hostResponse } from "./host-response.ts";
import { disposeAll, operations, permissionMatcher, pluginRegistry } from "./plugins.ts";
import { originOf, WebView } from "./webview.ts";
import { disposeWin32Bindings, hr, kernel, ole, Windows } from "./win32.ts";

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
const views = new Map<
  string,
  { boundary: ViewBoundary; native: WebView; detached: boolean; cleaned: boolean; ready: boolean }
>();
const approved = new Map<string, HostContext>();
const uiCalls = new Map<string, Extract<Packet, { kind: "operation" }>>();
function discardContext(context: HostContext) {
  for (const [id, approvedContext] of approved)
    if (approvedContext === context) approved.delete(id);
  for (const [id, call] of uiCalls) if (call.context === context) uiCalls.delete(id);
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
    } else if (packet.kind === "shutdown") {
      stopping = true;
      approved.clear();
      uiCalls.clear();
      for (const view of views.values()) {
        view.boundary.revoke("shutdown");
        view.boundary.closed = true;
        view.native.requestClose();
      }
    } else if (packet.kind === "server")
      views.get(packet.route.viewId)?.boundary.send(packet.route, packet.message);
    else if (packet.kind === "operation") {
      assert(
        !stopping && !uiCalls.has(packet.requestId) && uiCalls.size < API_LIMITS.maxPending,
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
      const queued = packet.kind === "grant" ? uiCalls.get(packet.requestId) : undefined;
      if (packet.kind === "grant") {
        if (!queued) return;
        assert(queued.context === packet.context);
        uiCalls.delete(packet.requestId);
      }
      const operation = packet.kind === "authorize" ? packet : queued;
      assert(operation);
      const view = [...views.values()].find((view) => view.boundary.active(packet.context));
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
      if (!allowed) log("host-request-denied", { operation: operation.call.operation });
      if (packet.kind === "grant") {
        assert(queued);
        const response = hostResponse(() => {
          if (!allowed)
            throw new BunawayError({
              code: "PERMISSION_DENIED",
              message: "Host context or policy denied.",
            });
          assert(adapters, "UI adapters are not initialized");
          return adapters.execute(queued.call.operation, queued.call.payload, queued.source);
        });
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
    } else if (packet.kind === "cancel-context") discardContext(packet.context);
    else if (packet.kind === "host-result") {
      const active =
        packet.context === config.backendContext ||
        [...views.values()].some((view) => view.boundary.active(packet.context));
      const context = approved.get(packet.requestId);
      approved.delete(packet.requestId);
      if (!stopping && active && context === packet.context) {
        channel.notify({ ...packet, kind: "host-response" });
      }
    } else throw new Error("Unexpected UI packet");
  },
  fail,
);

const log = (event: string, data: Record<string, unknown> = {}) => {
  console.log(JSON.stringify({ event, ...data }));
  channel.notify({ kind: "diagnostic", event, fields: data });
};
function startViews() {
  if (
    !startRequested ||
    starting ||
    stopping ||
    views.size !== config.windows.length ||
    [...views.values()].some((view) => !view.ready && !view.boundary.closed)
  )
    return;
  starting = true;
  for (const view of views.values()) if (!view.boundary.closed) view.native.navigate();
}
try {
  hr(ole.symbols.CoInitializeEx(null, 2), "CoInitializeEx(STA)");
  initialized = true;
  adapters = await operations(config.plugins ?? [], config.dataRoot, "ui");
  windows = new Windows();
  log("ui-thread", { pid: process.pid, thread: kernel.symbols.GetCurrentThreadId() });
  for (const spec of config.windows) {
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
          [...views.values()].reduce((total, view) => total + view.boundary.pendingCount, 0),
        ),
      forward: (packet) => {
        if (packet.kind === "revoke") discardContext(packet.route.context);
        channel.notify(packet);
      },
      deliver: (text) => native.send(text),
      log: (event, data) => log(event, { view: spec.view, ...data }),
    });
    const close = () => {
      boundary.revoke("closing");
      boundary.closed = true;
      native?.requestClose();
      log("view-window-closed", { view: spec.view });
      if (
        !closingSent &&
        views.size === config.windows.length &&
        [...views.values()].every((view) => view.boundary.closed)
      ) {
        closingSent = true;
        channel.notify({ kind: "closing" });
      }
    };
    const window = windows.create(spec.title, spec.window.width, spec.window.height, (message) => {
      if (message === 0x10) close();
      else if (message === 5) native?.resize();
      else if (message === 0x231) log("modal-enter", { view: spec.view });
      else if (message === 0x232) log("modal-exit", { view: spec.view });
    });
    log("window-created", { view: spec.view, hwnd: window.toString() });
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
            for (const [id, context] of approved) if (!activeContext(context)) approved.delete(id);
            for (const [id, call] of uiCalls) if (!activeContext(call.context)) uiCalls.delete(id);
          },
          sameDocument: (source) => boundary.sameDocument(source),
          close,
          ready: () => {
            const view = views.get(spec.view);
            assert(view);
            view.ready = true;
            startViews();
          },
          log: (event, data) => log(event, { view: spec.view, ...data }),
        },
        config.legacyProfile,
        config.devtools,
      );
    } catch (error) {
      windows.destroy(window);
      throw error;
    }
    views.set(spec.view, { boundary, native, detached: false, cleaned: false, ready: false });
  }
  function activeContext(context: HostContext) {
    return (
      context === config.backendContext ||
      [...views.values()].some((view) => view.boundary.active(context))
    );
  }
  await channel.send({ kind: "ready" });
  const startupDeadline = Date.now() + 30000;
  while (!stopping) {
    checkCallbacks();
    windows.pump();
    for (const view of views.values()) {
      if (view.native.failure) throw view.native.failure;
      if (!view.ready && !view.boundary.closed && Date.now() > startupDeadline)
        throw new Error("WebView startup timed out");
      view.boundary.scanDeadlines();
      if (view.boundary.closed && !view.detached && view.native.detach()) {
        windows.destroy(view.native.hwnd);
        view.detached = true;
      }
      if (view.detached && !view.cleaned) view.cleaned = view.native.finish();
    }
    if (!closingSent && [...views.values()].every((view) => view.boundary.closed)) {
      closingSent = true;
      channel.notify({ kind: "closing" });
    }
    if (failure) throw failure;
    // ponytail: bounded polling adds up to 5 ms latency; replace only after measuring idle CPU.
    await Bun.sleep(5);
  }
} catch (error) {
  failure ??= error;
  channel.notify({ kind: "fatal", error: { code: "INTERNAL", message: "Windows UI failed." } });
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
    while ([...views.values()].some((view) => !view.cleaned)) {
      assert(Date.now() < deadline, "STA cleanup timed out");
      windows?.pump();
      for (const view of views.values()) {
        if (!view.detached && view.native.detach()) {
          windows?.destroy(view.native.hwnd);
          view.detached = true;
        }
        if (view.detached && !view.cleaned) view.cleaned = view.native.finish();
      }
      await Bun.sleep(5);
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
      () => {
        windows?.dispose();
        if (initialized) ole.symbols.CoUninitialize();
        disposeWin32Bindings();
      },
    ]);
    await channel.drain();
    if (!failure) await channel.send({ kind: "cleaned" });
  } catch (error) {
    failure ??= error;
  }
  channel.close();
  parentPort.close();
}
if (failure) throw failure;
