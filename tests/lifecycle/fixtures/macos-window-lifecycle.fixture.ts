import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "@bunaway/protocol";
import type { Packet, Route } from "@bunaway/runtime-bun/worker-channel";

/**
 * Drives the real MacosWindows close order, lifecycle phases and resident-app signals for the app's
 * single window with a fake WebView. `mode` is the first argument: `quit` (default close behavior), `keep-alive` or
 * `reopen-failure` (keep-alive whose Dock reopen cannot create its window).
 * Prints one JSON result for the test to assert.
 */
const mode =
  process.argv[2] === "keep-alive" || process.argv[2] === "reopen-failure"
    ? process.argv[2]
    : "quit";
const ORIGIN = "https://app.bunaway.local";
const HOME = `${ORIGIN}/`;
const protocol = PROTOCOL_VERSION;

// Replace only the AppKit-backed modules; MacosWindows and its close logic stay real.
Bun.plugin({
  name: "fake-macos-native",
  setup(build) {
    build.onResolve(
      {
        filter: /\/(webview|application)\.ts$/,
      },
      (args) => ({
        path: args.path,
        namespace: "fake-macos-native",
      }),
    );
    build.onLoad(
      {
        filter: /.*/,
        namespace: "fake-macos-native",
      },
      (args) => ({
        contents: args.path.endsWith("/webview.ts")
          ? `export class MacosWebview {
              constructor(config, hooks) {
                if (globalThis.failWebviewCreation) {
                  throw new Error("fake creation failure");
                }
                globalThis.nativeHooks ??= {};
                globalThis.nativeHooks[config.window.view] = hooks;
                this.ready = Promise.resolve();
              }
              source() { return ${JSON.stringify(HOME)}; }
              deliver() {}
              present() {}
              start() {}
              observeStartup() {}
              close() {}
              isFocused() { return false; }
            }`
          : "export class MacosApplication { activate() {} close() {} }",
        loader: "js",
      }),
    );
  },
});

const { MacosWindows } = await import("../../../native/macos/bun/windows.ts");
const { DesktopRequests } = await import(
  "../../../native/macos/bun/desktop-requests.ts"
);

const windowSpec = (view: string) => ({
  view,
  home: HOME,
  title: view,
  window: {
    width: 800,
    height: 600,
  },
});
const policyView = (id: string) => ({
  id,
  origins: [
    ORIGIN,
  ],
  commands: [],
  events: [
    "windows.readiness",
    "windows.lifecycle",
    "windows.closeRequested",
  ],
  host: {
    permissions: [
      "windows.respondClose",
    ],
  },
});
const config = {
  runtime: {
    id: "test",
    generation: crypto.randomUUID(),
  },
  backendContext: "backend-test",
  assets: "unused",
  dataRoot: "unused",
  windows: [
    windowSpec("a"),
  ],
  policy: {
    version: 1,
    backend: {
      permissions: [],
    },
    views: [
      policyView("a"),
    ],
  },
} as never;

let recreating = false;
const forwarded: Packet[] = [];
const delivered: {
  to: string;
  event: string;
  payload: Record<string, unknown>;
}[] = [];
const quitRequests: string[] = [];
const logged: Record<string, unknown>[] = [];
const failures: string[] = [];
let windowsEmpty = 0;
let windowsGone = 0;
const desktop = new DesktopRequests({
  stopping: () => false,
  sendQuitRequest: (reason) => quitRequests.push(reason),
  sendOpenUrls: async () => {},
  deliverReopen: async () => {},
  diagnostic: () => {},
});
const windows = new MacosWindows(
  config,
  {} as never,
  {
    ready: () => true,
    stopping: () => false,
    // A recreation is a window API operation in flight, which the host treats as busy.
    busy: () => recreating,
    cancelled: () => false,
    requestContext: () => undefined,
    forward: (packet: Packet) => forwarded.push(packet),
    // The fake registry allows exactly the operations a view's policy lists.
    observes: (
      host: {
        permissions: string[];
      },
      call: {
        operation: string;
      },
    ) => host.permissions.includes(call.operation),
    nativeEvent: async (
      packet: Extract<
        Packet,
        {
          kind: "native-event";
        }
      >,
    ) => {
      delivered.push({
        to: packet.route.viewId,
        event: packet.event,
        payload: packet.payload as Record<string, unknown>,
      });
    },
    capacity: () => true,
    log: (event: string, fields?: object) => {
      logged.push({
        event,
        ...fields,
      });
    },
    // Only the failed-reopen scenario inspects host failures; the others must not produce any.
    fail: (error: unknown) => {
      if (mode !== "reopen-failure") {
        throw error;
      }
      failures.push(String(error));
    },
    desktop,
    windowsGone: () => {
      windowsGone++;
    },
    windowsEmpty: () => {
      windowsEmpty++;
    },
  } as never,
);
type NativeHooks = Record<
  string,
  {
    receive(source: string, raw: string): void;
    close(): void;
    documentComplete(error: null): void;
  }
>;
const nativeHooks = (
  globalThis as unknown as {
    nativeHooks: NativeHooks;
  }
).nativeHooks;

/** Opens the view's document session and confirms one subscription per listed event. */
function subscribe(view: string, events: string[]): Route {
  const hooks = nativeHooks[view];
  assert(hooks);
  hooks.receive(
    HOME,
    JSON.stringify({
      kind: "hello",
      protocol,
      features: [],
      buildId: "fixture",
    }),
  );
  const opened = forwarded.find(
    (packet) => packet.kind === "session-open" && packet.route.viewId === view,
  );
  assert(opened?.kind === "session-open");
  windows.send(opened.route, {
    kind: "hello",
    protocol,
    features: [],
    buildId: "fixture",
  });
  events.forEach((event, index) => {
    hooks.receive(
      HOME,
      JSON.stringify({
        kind: "listen",
        protocol,
        id: `${view}-listen-${index}`,
        event,
      }),
    );
    windows.send(opened.route, {
      kind: "result",
      protocol,
      id: `${view}-listen-${index}`,
      payload: {
        subscriptionId: `${view}-subscription-${index}`,
      },
    });
  });
  return opened.route;
}

/** Lets promise continuations and the fake ready promises settle. */
const settle = () => Bun.sleep(10);
const errorCode = (action: () => unknown) => {
  try {
    action();
  } catch (error) {
    return (
      (
        error as {
          code?: string;
        }
      ).code ?? "unknown"
    );
  }
  return "none";
};
const isClosed = (view: string) =>
  windows.services.read(view)?.closed ?? "missing";
// The window's own document never sees its closed and destroyed phases, so the host's lifecycle feed
// (what the backend's `windows.waitForLifecycle` reads) is the observer.
const lifecycle: {
  windowId: string;
  phase: string;
}[] = [];
windows.services.onLifecycle?.((event) => {
  lifecycle.push({
    windowId: event.windowId,
    phase: `${event.viewId}:${event.phase}`,
  });
});

await settle();
desktop.configure({
  closeBehavior: mode === "quit" ? "quit" : "keep-alive",
  reopenHandler: false,
});
// Only the quit scenario asks the document; keep-alive closes straight away.
subscribe(
  "a",
  mode === "quit"
    ? [
        "windows.closeRequested",
      ]
    : [],
);

const result: Record<string, unknown> = {
  mode,
};
if (mode === "quit") {
  // 1. A subscribed document is asked first; denying keeps the window.
  nativeHooks.a?.close();
  await settle();
  const first = delivered.filter(
    (entry) => entry.event === "windows.closeRequested",
  );
  const respondA = windows.services.window("a");
  respondA.respondClose?.(1, false);
  await settle();
  result.afterDeny = {
    requests: first.map((entry) => [
      entry.to,
      entry.payload.requestId,
    ]),
    closed: isClosed("a"),
  };

  // 2. While a request is pending: repeated user closes are ignored, the public close is BUSY.
  nativeHooks.a?.close();
  await settle();
  nativeHooks.a?.close();
  await settle();
  const pending = windows.services.window("a").close();
  const busy = await Promise.resolve(pending).then(
    () => "resolved",
    (error: { code?: string }) => error.code ?? "unknown",
  );
  result.whilePending = {
    requests: delivered.filter(
      (entry) => entry.event === "windows.closeRequested",
    ).length,
    publicClose: busy,
    recreate: errorCode(() => windows.services.close("a", true)),
    stale: errorCode(() => respondA.respondClose?.(1, true)),
  };

  // 3. Allowing the only window asks the app to quit and keeps the window while the app decides.
  respondA.respondClose?.(2, true);
  await settle();
  result.afterAllow = {
    closed: isClosed("a"),
    quitRequests: [
      ...quitRequests,
    ],
    quitPending: desktop.quitPending,
  };

  // 4. A veto lets the next close ask the document again, and allowing asks to quit again.
  desktop.quitCancelled();
  await settle();
  nativeHooks.a?.close();
  await settle();
  respondA.respondClose?.(3, true);
  await settle();
  result.afterVeto = {
    requests: delivered.filter(
      (entry) => entry.event === "windows.closeRequested",
    ).length,
    quitRequests: [
      ...quitRequests,
    ],
    closed: isClosed("a"),
  };

  // 5. Recreating is announced as closed and destroyed for the old windowId, then created and ready for
  // a new one, and does not ask the app to quit.
  desktop.quitCancelled();
  await settle();
  recreating = true;
  await windows.services.close("a", true);
  windows.tick();
  await settle();
  windows.services.create(windowSpec("a") as never, true);
  await settle();
  nativeHooks.a?.documentComplete(null);
  await settle();
  recreating = false;
  result.lifecycle = lifecycle.map((entry) => entry.phase);
  // A listener that subscribes late, as the backend's adapter does after the first window is up,
  // still receives every phase from the start.
  const late: string[] = [];
  windows.services.onLifecycle?.((event) => {
    late.push(`${event.viewId}:${event.phase}`);
  });
  result.lateLifecycle = late;
  const windowIds = lifecycle.map((entry) => entry.windowId);
  result.windowLifetimes = windowIds.map((id) =>
    id === windowIds[0] ? "old" : "new",
  );
  result.afterRecreate = {
    quitRequests: [
      ...quitRequests,
    ],
    closed: isClosed("a"),
  };
  windows.tick();
  result.windowsGone = windowsGone;
} else if (mode === "reopen-failure") {
  nativeHooks.a?.close();
  await settle();
  windows.tick();
  // The Dock reopen cannot create its window: the host keeps running and only logs the failure.
  const globals = globalThis as unknown as {
    failWebviewCreation?: boolean;
  };
  globals.failWebviewCreation = true;
  windows.requestShow();
  windows.tick();
  await settle();
  result.afterFailedReopen = {
    failures: [
      ...failures,
    ],
    logged: logged.filter(
      (entry) => entry.event === "reopen-window-creation-failed",
    ),
    windowsGone,
    aClosed: isClosed("a"),
  };
  // The request was consumed, so later ticks do not retry; the next reopen does.
  globals.failWebviewCreation = false;
  windows.tick();
  windows.tick();
  result.afterIdleTicks = {
    aClosed: isClosed("a"),
  };
  windows.requestShow();
  windows.tick();
  await settle();
  result.afterNextReopen = {
    failures: [
      ...failures,
    ],
    aClosed: isClosed("a"),
  };
} else {
  // keep-alive: closing the window never asks the app to quit and reports an empty app.
  // A tick while the window is ready records that the app had a live window.
  windows.tick();
  nativeHooks.a?.close();
  await settle();
  windows.tick();
  windows.tick();
  result.afterClose = {
    aClosed: isClosed("a"),
    windowsEmpty,
    quitRequests: [
      ...quitRequests,
    ],
    windowsGone,
  };
  // Showing creates the window again and re-arms the report.
  windows.requestShow();
  windows.tick();
  await settle();
  windows.tick();
  result.afterShow = {
    aClosed: isClosed("a"),
  };
  nativeHooks.a?.close();
  await settle();
  windows.tick();
  result.afterSecondEmpty = {
    windowsEmpty,
  };
}
console.log(JSON.stringify(result));
windows.close();
