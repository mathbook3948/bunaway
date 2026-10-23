import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "@bunaway/protocol";
import type { Packet, Route } from "@bunaway/runtime-bun/worker-channel";

/**
 * Drives the real MacosWindows plugin event broadcast with a fake WebView: only the view whose
 * document subscribed receives the event, a required operation also needs the view's host
 * permission, and nothing is sent once the host is stopping.
 * Prints one JSON result for the test to assert.
 */
const ORIGIN = "https://app.bunaway.local";
const HOME = `${ORIGIN}/`;
const EVENT = "plugin.ping";
const protocol = PROTOCOL_VERSION;

// Replace only the AppKit-backed modules; MacosWindows and its event delivery stay real.
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
const READ = "plugin.read";
// Granted to view a but never registered, like an operation no installed plugin declares.
const UNREGISTERED = "plugin.unregistered";
const registered = new Set([
  READ,
]);
let readRevoked = false;
const policyView = (id: string, permissions: string[] = []) => ({
  id,
  origins: [
    ORIGIN,
  ],
  commands: [],
  events: [
    EVENT,
  ],
  host: {
    permissions,
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
    windowSpec("b"),
    windowSpec("c"),
  ],
  policy: {
    version: 1,
    backend: {
      permissions: [],
    },
    views: [
      policyView("a", [
        READ,
        UNREGISTERED,
      ]),
      policyView("b"),
      policyView("c", [
        READ,
      ]),
    ],
  },
} as never;

const forwarded: Packet[] = [];
const delivered: {
  to: string;
  payload: unknown;
}[] = [];
let stopping = false;
const desktop = new DesktopRequests({
  stopping: () => false,
  sendQuitRequest: () => {},
  sendOpenUrls: async () => {},
  deliverReopen: async () => {},
  diagnostic: () => {},
});
const windows = new MacosWindows(
  config,
  {} as never,
  {
    ready: () => true,
    stopping: () => stopping,
    busy: () => false,
    cancelled: () => false,
    requestContext: () => undefined,
    forward: (packet: Packet) => forwarded.push(packet),
    observes: (
      host: {
        permissions: string[];
      },
      call: {
        operation: string;
      },
    ) =>
      registered.has(call.operation) &&
      !(readRevoked && call.operation === READ) &&
      host.permissions.includes(call.operation),
    nativeEvent: async (
      packet: Extract<
        Packet,
        {
          kind: "native-event";
        }
      >,
    ) => {
      if (packet.event === EVENT) {
        delivered.push({
          to: packet.route.viewId,
          payload: packet.payload,
        });
      }
    },
    capacity: () => true,
    log: () => {},
    fail: (error: unknown) => {
      throw error;
    },
    desktop,
    windowsGone: () => {},
    windowsEmpty: () => {},
  } as never,
);
type NativeHooks = Record<
  string,
  {
    receive(source: string, raw: string): void;
  }
>;
const nativeHooks = (
  globalThis as unknown as {
    nativeHooks: NativeHooks;
  }
).nativeHooks;

/** `confirmed` answers the listen request, `pending` leaves it unanswered, `none` sends none. */
type Subscription = "confirmed" | "pending" | "none";

/** Opens the view's document session and subscribes to the event as asked. */
function open(view: string, subscription: Subscription): Route {
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
  if (subscription !== "none") {
    hooks.receive(
      HOME,
      JSON.stringify({
        kind: "listen",
        protocol,
        id: `${view}-listen`,
        event: EVENT,
      }),
    );
    if (subscription === "confirmed") {
      windows.send(opened.route, {
        kind: "result",
        protocol,
        id: `${view}-listen`,
        payload: {
          subscriptionId: `${view}-subscription`,
        },
      });
    }
  }
  return opened.route;
}

const settle = () => Bun.sleep(10);

await settle();
open("a", "confirmed");
open("b", "pending");
open("c", "none");

// Delivery is synchronous up to the host hook, so no wait is needed to observe it.
windows.emitPluginEvent(EVENT, {
  count: 1,
});
const whileRunning = delivered.splice(0);
// View a is subscribed with the grant, b is pending without it, c has the grant but no subscription.
windows.emitPluginEvent(
  EVENT,
  {
    count: 3,
  },
  READ,
);
const withGrant = delivered.splice(0);
windows.emitPluginEvent(
  EVENT,
  {
    count: 4,
  },
  UNREGISTERED,
);
const unknownOperation = delivered.splice(0);
// The grant is checked at every emit: once revoked, the subscribed view stops receiving.
readRevoked = true;
windows.emitPluginEvent(
  EVENT,
  {
    count: 5,
  },
  READ,
);
const afterRevoke = delivered.splice(0);
stopping = true;
windows.emitPluginEvent(EVENT, {
  count: 2,
});
console.log(
  JSON.stringify({
    whileRunning,
    withGrant,
    unknownOperation,
    afterRevoke,
    whileStopping: delivered,
  }),
);
windows.close();
