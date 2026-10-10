import { expect, test } from "bun:test";
import { createClient, createWebViewTransport } from "@bunaway/client";
import type { WindowReadiness } from "@bunaway/plugin-api/native";
import {
  validateWindowCall,
  validateWindowOutput,
} from "@bunaway/plugin-windows";
import {
  type HostContext,
  type Hello,
  parseMessage,
  PROTOCOL_VERSION,
  SDK_READY_FEATURE,
  serializeMessage,
} from "@bunaway/protocol";
import { ViewBoundary } from "@bunaway/runtime-bun/view-boundary";
import type { Packet, Route } from "@bunaway/runtime-bun/worker-channel";
import { WindowReadinessTracker } from "#native/windows/bun/window-readiness";

function fixture(showWhenReady: "document" | "sdk" = "sdk") {
  const events: WindowReadiness[] = [];
  let shows = 0;
  const tracker = new WindowReadinessTracker(
    "window-original",
    "main",
    showWhenReady,
    {
      publish: (state) => events.push(state),
      show: () => {
        shows++;
      },
    },
  );
  return {
    tracker,
    events,
    shows: () => shows,
  };
}

test("native, document and acknowledged SDK preparation are independent and recovered without replay", () => {
  const f = fixture();
  expect(f.tracker.snapshot()).toMatchObject({
    nativeCreated: true,
    document: "pending",
    sdk: "pending",
  });
  f.tracker.reset(1);
  f.tracker.sdkComplete(1);
  expect(f.shows()).toBe(0);
  f.tracker.documentComplete(null);
  expect(f.shows()).toBe(1);
  const snapshot = validateWindowOutput(
    "windows.getReadiness",
    f.tracker.snapshot(),
  );
  expect(snapshot).toMatchObject({
    windowId: "window-original",
    documentGeneration: 1,
    document: "ready",
    sdk: "ready",
  });
  expect(f.events.at(-1)).toEqual(snapshot);
  snapshot.error = {
    code: "INTERNAL",
    message: "changed copy",
  };
  expect(f.tracker.snapshot().error).toBeNull();
  f.tracker.reset(2);
  f.tracker.sdkComplete(1);
  expect(f.tracker.snapshot().sdk).toBe("pending");
  f.tracker.documentComplete(null);
  f.tracker.sdkComplete(2);
  expect(f.shows()).toBe(1);
  expect(f.tracker.snapshot().windowId).toBe("window-original");
});

test("document-only display, new HWND identity, reconnect and terminal failure never show prematurely", () => {
  const document = fixture("document");
  document.tracker.documentComplete(null);
  expect(document.shows()).toBe(1);
  expect(document.tracker.snapshot().sdk).toBe("pending");
  document.tracker.sdkComplete(0);
  document.tracker.sessionEnded(1, {
    code: "CANCELLED",
    message: "client close",
  });
  expect(document.tracker.snapshot()).toMatchObject({
    document: "ready",
    sdk: "cancelled",
  });
  document.tracker.sessionOpened(1);
  document.tracker.sdkComplete(1);
  expect(document.tracker.snapshot()).toMatchObject({
    sdk: "ready",
  });
  for (const code of [
    "CANCELLED",
    "INTERNAL",
  ] as const) {
    const f = fixture();
    f.tracker.terminate({
      code,
      message: "closed or failed",
    });
    f.tracker.documentComplete(null);
    f.tracker.sdkComplete(0);
    expect(f.shows()).toBe(0);
    expect(f.tracker.snapshot().document).toBe(
      code === "CANCELLED" ? "cancelled" : "failed",
    );
  }
  const replacement = new WindowReadinessTracker(
    "window-new",
    "main",
    undefined,
    {
      publish() {},
      show() {},
    },
  );
  expect(replacement.snapshot()).toMatchObject({
    windowId: "window-new",
    revision: 0,
    documentGeneration: 0,
    sdk: "pending",
  });
});

test("preparation deadlines and navigation failure suppress late success but allow a fresh navigation", () => {
  const f = fixture();
  f.tracker.expireSdk();
  expect(f.tracker.snapshot()).toMatchObject({
    document: "pending",
    sdk: "failed",
    error: {
      code: "TIMEOUT",
    },
  });
  f.tracker.documentComplete(null);
  f.tracker.sdkComplete(0);
  expect(f.shows()).toBe(0);
  f.tracker.reset(1);
  f.tracker.expireDocument();
  expect(f.tracker.snapshot()).toMatchObject({
    document: "failed",
    sdk: "cancelled",
    error: {
      code: "TIMEOUT",
    },
  });
  f.tracker.reset(2);
  f.tracker.documentComplete({
    code: "CANCELLED",
    message: "window.stop",
  });
  expect(f.tracker.snapshot().document).toBe("cancelled");
  f.tracker.documentComplete(null);
  expect(f.shows()).toBe(0);
  f.tracker.reset(3);
  f.tracker.documentComplete(null);
  f.tracker.sdkComplete(3);
  expect(f.shows()).toBe(1);
});

test("SDK acknowledgement requires a current negotiated session and never forwards a new command", () => {
  const packets: Packet[] = [];
  let capacity = true;
  const ready: Route[] = [];
  const revoked: number[] = [];
  const hello = {
    kind: "hello",
    protocol: PROTOCOL_VERSION,
    features: [
      SDK_READY_FEATURE,
    ],
    buildId: "test",
  } as const;
  const boundary = new ViewBoundary(
    {
      id: "main",
      origins: [
        "https://app.bunaway.local",
      ],
      commands: [],
      events: [],
      host: {
        permissions: [],
      },
    },
    {
      origin: (source) => new URL(source).origin,
      source: () => "https://app.bunaway.local/index.html",
      ready: () => true,
      forward: (packet) => packets.push(packet),
      capacity: () => capacity,
      deliver() {},
      log() {},
      sdkReady: (route) => ready.push(route),
      revoked: (_reason, generation) => revoked.push(generation),
    },
  );
  const source = "https://app.bunaway.local/index.html";
  const acknowledgement = serializeMessage({
    kind: "sdk-ready",
    protocol: PROTOCOL_VERSION,
  });
  boundary.receive(source, acknowledgement);
  expect(ready).toHaveLength(0);
  boundary.receive(
    source,
    serializeMessage({
      ...hello,
      features: [
        ...hello.features,
      ],
    }),
  );
  const packet = packets[0];
  expect(packet?.kind).toBe("session-open");
  if (packet?.kind !== "session-open") {
    throw new Error("Missing route");
  }
  capacity = false;
  boundary.receive(source, acknowledgement);
  expect(ready).toHaveLength(0);
  boundary.send(packet.route, {
    ...hello,
    features: [
      ...hello.features,
    ],
  });
  boundary.receive("https://evil.example/index.html", acknowledgement);
  expect(ready).toHaveLength(0);
  boundary.receive(source, acknowledgement);
  boundary.receive(source, acknowledgement);
  expect(ready).toEqual([
    packet.route,
  ]);
  expect(packets).toHaveLength(2);
  boundary.revoke("navigation");
  boundary.send(packet.route, {
    ...hello,
    features: [
      ...hello.features,
    ],
  });
  boundary.receive(source, acknowledgement);
  expect(ready).toHaveLength(1);
  expect(revoked).toEqual([
    1,
  ]);
  expect(boundary.active(packet.route.context as HostContext)).toBe(false);
});

test("SDK readiness and automatic display complete while the Worker channel is full", async () => {
  const f = fixture();
  f.tracker.documentComplete(null);
  const source = "https://app.bunaway.local/index.html";
  const hello: Hello = {
    kind: "hello",
    protocol: PROTOCOL_VERSION,
    features: [
      SDK_READY_FEATURE,
    ],
    buildId: "test",
  };
  const packets: Packet[] = [];
  const listeners = new Set<(event: { data: unknown }) => void>();
  let capacity = true;
  const boundary = new ViewBoundary(
    {
      id: "main",
      origins: [
        new URL(source).origin,
      ],
      commands: [
        "test.command",
      ],
      events: [],
      host: {
        permissions: [],
      },
    },
    {
      origin: (text) => new URL(text).origin,
      source: () => source,
      ready: () => true,
      capacity: () => capacity,
      forward: (packet) => packets.push(packet),
      deliver: (text) => {
        for (const listener of listeners) {
          listener({
            data: parseMessage(text),
          });
        }
      },
      log() {},
      sessionOpened: (route) =>
        f.tracker.sessionOpened(route.documentGeneration),
      sdkReady: (route) => f.tracker.sdkComplete(route.documentGeneration),
    },
  );
  const client = createClient({
    hello,
    transport: createWebViewTransport({
      postMessage: (message) =>
        boundary.receive(source, JSON.stringify(message)),
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    }),
  });
  try {
    const opened = packets[0];
    if (opened?.kind !== "session-open") {
      throw new Error("Missing session");
    }
    // Other views can fill the shared channel before this client's acknowledgement arrives.
    capacity = false;
    boundary.send(opened.route, hello);
    await client.ready;
    expect(f.tracker.snapshot()).toMatchObject({
      document: "ready",
      sdk: "ready",
      error: null,
    });
    expect(f.shows()).toBe(1);
    expect(packets).toHaveLength(2);
    f.tracker.expireSdk();
    expect(f.tracker.snapshot().sdk).toBe("ready");
    // Local readiness must not allow commands to bypass the shared channel's bound.
    await expect(client.invoke("test.command", null)).rejects.toMatchObject({
      code: "BUSY",
    });
    expect(packets).toHaveLength(2);
  } finally {
    await client.close();
  }
  expect(listeners.size).toBe(0);
});

test("preparation schemas reject invalid phases and splashscreen targets", () => {
  const f = fixture();
  expect(() =>
    validateWindowOutput("windows.getReadiness", {
      ...f.tracker.snapshot(),
      sdk: "loaded",
    }),
  ).toThrow();
  expect(() =>
    validateWindowCall({
      operation: "windows.completeSplashscreen",
      payload: {
        view: "main",
      },
    }),
  ).toThrow();
  expect(
    validateWindowCall({
      operation: "windows.completeSplashscreen",
      payload: {
        view: "main",
        splash: "splash",
      },
    }).operation,
  ).toBe("windows.completeSplashscreen");
});

test("document failure retains an already acknowledged SDK and its error through reconnection", () => {
  const f = fixture();
  f.tracker.sdkComplete(0);
  f.tracker.documentComplete({
    code: "INTERNAL",
    message: "Document aborted",
  });
  expect(f.tracker.snapshot()).toMatchObject({
    document: "failed",
    sdk: "ready",
    error: {
      code: "INTERNAL",
    },
  });
  f.tracker.sessionOpened(1);
  f.tracker.sdkComplete(1);
  expect(f.tracker.snapshot()).toMatchObject({
    document: "failed",
    sdk: "ready",
    error: {
      code: "INTERNAL",
    },
  });
  expect(f.shows()).toBe(0);
});
