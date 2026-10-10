import { expect, test } from "bun:test";
import type { WindowReadiness } from "@bunaway/plugin-api/native";
import {
  validateWindowCall,
  validateWindowOutput,
} from "@bunaway/plugin-windows";
import {
  type HostContext,
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
      capacity: () => true,
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
