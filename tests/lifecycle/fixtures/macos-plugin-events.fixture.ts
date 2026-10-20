import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "@bunaway/protocol";
import type { Packet, Route } from "@bunaway/runtime-bun/worker-channel";

/**
 * Drives the real MacosWindows plugin event broadcast with a fake WebView: only the view whose
 * document subscribed receives the event, and nothing is sent once the host is stopping.
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
const policyView = (id: string) => ({
  id,
  origins: [
    ORIGIN,
  ],
  commands: [],
  events: [
    EVENT,
  ],
  host: {
    permissions: [],
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
  ],
  policy: {
    version: 1,
    backend: {
      permissions: [],
    },
    views: [
      policyView("a"),
      policyView("b"),
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
    observes: () => false,
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

/** Opens the view's document session and, when asked, confirms one subscription to the event. */
function open(view: string, subscribe: boolean): Route {
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
  if (subscribe) {
    hooks.receive(
      HOME,
      JSON.stringify({
        kind: "listen",
        protocol,
        id: `${view}-listen`,
        event: EVENT,
      }),
    );
    windows.send(opened.route, {
      kind: "result",
      protocol,
      id: `${view}-listen`,
      payload: {
        subscriptionId: `${view}-subscription`,
      },
    });
  }
  return opened.route;
}

const settle = () => Bun.sleep(10);

await settle();
open("a", true);
open("b", false);

windows.emitPluginEvent(EVENT, {
  count: 1,
});
await settle();
const whileRunning = delivered.splice(0);
stopping = true;
windows.emitPluginEvent(EVENT, {
  count: 2,
});
await settle();
console.log(
  JSON.stringify({
    whileRunning,
    whileStopping: delivered,
  }),
);
windows.close();
