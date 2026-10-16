import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "@bunaway/protocol";
import type { Packet } from "@bunaway/runtime-bun/worker-channel";

/** Dynamic view whose fake native constructor throws. */
const FAILING_VIEW = "broken";
const ORIGIN = "https://app.bunaway.local";
const HOME = `${ORIGIN}/`;

// Replace only the AppKit-backed modules; MacosWindows and its readiness logic stay real.
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
                if (config.window.view === ${JSON.stringify(FAILING_VIEW)}) {
                  throw new Error("native constructor failed");
                }
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

const protocol = PROTOCOL_VERSION;
const windowSpec = (view: string, startup: boolean) => ({
  view,
  home: HOME,
  title: view,
  startup,
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
    windowSpec("main", true),
    windowSpec(FAILING_VIEW, false),
  ],
  policy: {
    version: 1,
    backend: {
      permissions: [],
    },
    views: [
      policyView("main"),
      policyView(FAILING_VIEW),
    ],
  },
} as never;

const forwarded: Packet[] = [];
const published: {
  payload: {
    viewId: string;
    error: {
      code: string;
    } | null;
  };
}[] = [];
const windows = new MacosWindows(config, {} as never, {
  ready: () => true,
  stopping: () => false,
  busy: () => false,
  cancelled: () => false,
  requestContext: () => undefined,
  forward: (packet: Packet) => forwarded.push(packet),
  observes: () => true,
  nativeEvent: async (packet: never) => {
    published.push(packet);
  },
  capacity: () => true,
  log: () => {},
  fail: (error: unknown) => {
    throw error;
  },
  desktop: new DesktopRequests({
    stopping: () => false,
    sendQuitRequest: () => {},
    sendOpenUrls: async () => {},
    deliverReopen: async () => {},
    diagnostic: () => {},
  }),
  windowsGone: () => {},
  windowsEmpty: () => {},
});

// Subscribe the live main view: client hello opens a session, the server hello negotiates it,
// then a listen makes it a recipient of windows.readiness events.
const mainHooks = (
  globalThis as unknown as {
    nativeHooks: Record<
      string,
      {
        receive(source: string, raw: string): void;
      }
    >;
  }
).nativeHooks.main;
assert(mainHooks);
const fromWebView = (message: object) =>
  mainHooks.receive(HOME, JSON.stringify(message));
fromWebView({
  kind: "hello",
  protocol,
  features: [],
  buildId: "fixture",
});
const opened = forwarded.find((packet) => packet.kind === "session-open");
assert(opened?.kind === "session-open");
windows.send(opened.route, {
  kind: "hello",
  protocol,
  features: [],
  buildId: "fixture",
});
fromWebView({
  kind: "listen",
  protocol,
  id: "listen-1",
  event: "windows.readiness",
});

let createError: unknown;
try {
  windows.services.create(windowSpec(FAILING_VIEW, false) as never);
} catch (error) {
  createError = error;
}
const readiness = windows.services.window(FAILING_VIEW).getReadiness();
console.log(
  JSON.stringify({
    createError: createError instanceof Error ? createError.message : null,
    published: published
      .filter((packet) => packet.payload.viewId === FAILING_VIEW)
      .map((packet) => packet.payload.error?.code ?? null),
    readiness: {
      document: readiness.document,
      sdk: readiness.sdk,
      error: readiness.error?.code ?? null,
    },
  }),
);
windows.close();
