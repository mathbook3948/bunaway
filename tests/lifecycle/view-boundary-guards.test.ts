import { expect, test } from "bun:test";
import {
  API_LIMITS,
  type Policy,
  PROTOCOL_VERSION,
  parseMessage,
  type ServerMessage,
} from "@bunaway/protocol";
import { ViewBoundary } from "@bunaway/runtime-bun/view-boundary";
import type { Packet } from "#native/windows/bun/channel";

const origin = "https://app.bunaway.local";
const source = `${origin}/index.html`;
const view: Policy["views"][number] = {
  id: "main",
  origins: [
    origin,
  ],
  commands: [
    "ping",
  ],
  events: [
    "changed",
  ],
  host: {
    permissions: [],
  },
};

function setup(options: { ready?: boolean; capacity?: number } = {}) {
  const state = {
    ready: options.ready ?? true,
    capacity: options.capacity ?? Number.POSITIVE_INFINITY,
  };
  const delivered: string[] = [];
  const packets: Packet[] = [];
  const logs: string[] = [];
  const sdkReady: string[] = [];
  const boundary = new ViewBoundary(view, {
    origin: (text) => new URL(text).origin,
    source: () => source,
    ready: () => state.ready,
    capacity: (count) => count <= state.capacity,
    forward: (packet) => packets.push(packet),
    deliver: (text) => delivered.push(text),
    log: (event) => logs.push(event),
    sdkReady: (route) => sdkReady.push(route.context),
  });
  const receive = (message: object, from = source) =>
    boundary.receive(
      from,
      JSON.stringify({
        protocol: PROTOCOL_VERSION,
        ...message,
      }),
    );
  /** Kinds of the client messages forwarded to the backend, in order. */
  const forwarded = () =>
    packets.flatMap((packet) =>
      packet.kind === "client"
        ? [
            packet.message.kind,
          ]
        : [],
    );
  /** The last error delivered to the WebView, as code and message. */
  const lastError = () => {
    const message = parseMessage(delivered.at(-1) ?? "");
    return message.kind === "error"
      ? `${message.id} ${message.error.code} ${message.error.message}`
      : message.kind;
  };
  const open = (features: string[] = []) => {
    receive({
      kind: "hello",
      features,
      buildId: "test",
    });
    const opened = packets.find((packet) => packet.kind === "session-open");
    if (opened?.kind !== "session-open") {
      throw new Error("Missing session");
    }
    return opened.route;
  };
  const negotiate = (features: string[] = []) => {
    const route = open(features);
    boundary.send(route, {
      kind: "hello",
      protocol: PROTOCOL_VERSION,
      features,
      buildId: "test",
    } as ServerMessage);
    return route;
  };
  return {
    boundary,
    state,
    delivered,
    packets,
    logs,
    forwarded,
    sdkReady,
    receive,
    lastError,
    open,
    negotiate,
  };
}

test("a message is rejected with a stable error before any session exists", () => {
  const f = setup();
  f.receive({
    kind: "invoke",
    id: "first",
    command: "ping",
    payload: null,
  });
  expect(f.lastError()).toBe(
    "first INVALID_ARGUMENT First message must be hello.",
  );
  f.receive({
    kind: "result",
    id: "wrong-direction",
    payload: null,
  });
  expect(f.lastError()).toBe(
    "wrong-direction INVALID_ARGUMENT Invalid Web direction.",
  );
  f.boundary.receive(
    source,
    JSON.stringify({
      kind: "close",
      id: "mismatch",
      protocol: {
        major: PROTOCOL_VERSION.major,
        minor: PROTOCOL_VERSION.minor + 1,
      },
    }),
  );
  expect(f.lastError()).toBe("mismatch INVALID_ARGUMENT Rejected Web message.");
  f.receive(
    {
      kind: "hello",
      features: [],
      buildId: "test",
    },
    "https://attacker.example/index.html",
  );
  expect(f.delivered).toHaveLength(3);
  expect(f.packets).toHaveLength(0);
  expect(
    f.logs.filter((event) => event === "web-message-rejected"),
  ).toHaveLength(4);
});

test("a hello is refused while the backend is not ready, from another document or without capacity", () => {
  const notReady = setup({
    ready: false,
  });
  notReady.receive({
    kind: "invoke",
    id: "early",
    command: "ping",
    payload: null,
  });
  expect(notReady.lastError()).toBe("early BUSY Backend is not ready.");

  const otherDocument = setup();
  otherDocument.receive({
    kind: "invoke",
    id: "foreign",
    command: "ping",
    payload: null,
  });
  otherDocument.boundary.receive(
    `${origin}/other.html`,
    JSON.stringify({
      kind: "invoke",
      id: "other",
      protocol: PROTOCOL_VERSION,
      command: "ping",
      payload: null,
    }),
  );
  expect(otherDocument.lastError()).toBe(
    "other PERMISSION_DENIED Message source is not allowed.",
  );

  const full = setup({
    capacity: 1,
  });
  full.receive({
    kind: "hello",
    features: [],
    buildId: "test",
  });
  expect(full.packets).toHaveLength(0);
  expect(full.delivered).toHaveLength(0);
});

test("an open session requires a single hello, negotiation, capacity and the same document", () => {
  const f = setup();
  f.open();
  f.receive({
    kind: "hello",
    features: [],
    buildId: "test",
  });
  expect(f.delivered).toHaveLength(0);
  expect(f.logs.at(-1)).toBe("web-message-rejected");
  f.receive({
    kind: "invoke",
    id: "early",
    command: "ping",
    payload: null,
  });
  expect(f.lastError()).toBe(
    "early INVALID_ARGUMENT Session is not negotiated.",
  );
  expect(f.packets.map((packet) => packet.kind)).toEqual([
    "session-open",
    "client",
  ]);
});

test("sdk-ready needs negotiation of the feature and is handled without forwarding", () => {
  const f = setup();
  const route = f.negotiate([
    "sdk-ready",
  ]);
  expect(route.viewId).toBe("main");
  const negotiated = f.delivered.length;
  f.receive({
    kind: "sdk-ready",
  });
  f.receive({
    kind: "sdk-ready",
  });
  expect(f.packets.map((packet) => packet.kind)).toEqual([
    "session-open",
    "client",
  ]);
  expect(f.delivered).toHaveLength(negotiated);
  expect(f.sdkReady).toEqual([
    route.context,
  ]);

  const unsupported = setup();
  unsupported.negotiate();
  const unsupportedBase = unsupported.delivered.length;
  unsupported.receive({
    kind: "sdk-ready",
  });
  expect(unsupported.delivered).toHaveLength(unsupportedBase);
  expect(unsupported.logs).toContain("web-message-rejected");
  expect(unsupported.forwarded()).toEqual([
    "hello",
  ]);
});

test("commands and events outside the view policy are denied and logged", () => {
  const f = setup();
  f.negotiate();
  f.receive({
    kind: "invoke",
    id: "denied-command",
    command: "secret",
    payload: null,
  });
  expect(f.lastError()).toBe(
    "denied-command PERMISSION_DENIED Command is not allowed for this view.",
  );
  f.receive({
    kind: "listen",
    id: "denied-event",
    event: "secret",
  });
  expect(f.lastError()).toBe(
    "denied-event PERMISSION_DENIED Event is not allowed for this view.",
  );
  expect(f.logs.filter((event) => event === "permission-denied")).toHaveLength(
    2,
  );
  expect(f.forwarded()).toEqual([
    "hello",
  ]);
});

test("request ids are single use and the pending, deadline and capacity limits apply", () => {
  const f = setup();
  f.negotiate();
  f.receive({
    kind: "invoke",
    id: "one",
    command: "ping",
    payload: null,
  });
  expect(f.forwarded()).toEqual([
    "hello",
    "invoke",
  ]);
  f.receive({
    kind: "invoke",
    id: "one",
    command: "ping",
    payload: null,
  });
  expect(f.lastError()).toBe(
    "one INVALID_ARGUMENT Request ID was already used.",
  );
  f.receive({
    kind: "invoke",
    id: "late",
    command: "ping",
    payload: null,
    deadline: Date.now() - 1,
  });
  expect(f.lastError()).toBe("late TIMEOUT Request deadline passed.");
  f.state.capacity = 0;
  f.receive({
    kind: "invoke",
    id: "full",
    command: "ping",
    payload: null,
  });
  expect(f.lastError()).toBe("full BUSY UI channel is full.");
  f.state.capacity = Number.POSITIVE_INFINITY;
  for (let index = 0; index < API_LIMITS.maxPending; index++) {
    f.receive({
      kind: "invoke",
      id: `bulk-${index}`,
      command: "ping",
      payload: null,
    });
  }
  expect(f.lastError()).toBe(
    `bulk-${API_LIMITS.maxPending - 1} BUSY Request limit reached.`,
  );
});

test("cancel answers a pending invoke once, keeps a listen and ignores unknown ids", () => {
  const f = setup();
  const route = f.negotiate();
  f.receive({
    kind: "invoke",
    id: "run",
    command: "ping",
    payload: null,
  });
  f.receive({
    kind: "listen",
    id: "watch",
    event: "changed",
  });
  const clientKinds = () => f.forwarded().length;
  expect(clientKinds()).toBe(3);
  f.receive({
    kind: "cancel",
    id: "unknown",
  });
  expect(clientKinds()).toBe(3);
  f.receive({
    kind: "cancel",
    id: "watch",
  });
  expect(clientKinds()).toBe(3);
  expect(f.boundary.eventRoute("changed")).toEqual(route);
  f.receive({
    kind: "cancel",
    id: "run",
  });
  expect(f.lastError()).toBe("run CANCELLED Request cancelled.");
  expect(clientKinds()).toBe(4);
  f.receive({
    kind: "cancel",
    id: "run",
  });
  expect(clientKinds()).toBe(4);
  expect(f.delivered).toHaveLength(2);
  // The terminal reply of a cancelled request is discarded.
  const before = f.delivered.length;
  f.boundary.send(route, {
    kind: "result",
    protocol: PROTOCOL_VERSION,
    id: "run",
    payload: null,
  });
  expect(f.delivered).toHaveLength(before);
});

test("server messages are checked against the session before delivery", () => {
  const f = setup();
  const route = f.negotiate();
  expect(() =>
    f.boundary.send(route, {
      kind: "hello",
      protocol: PROTOCOL_VERSION,
      features: [],
      buildId: "test",
    } as ServerMessage),
  ).toThrow("Duplicate server hello");
  f.receive({
    kind: "listen",
    id: "watch",
    event: "changed",
  });
  expect(() =>
    f.boundary.send(route, {
      kind: "result",
      protocol: PROTOCOL_VERSION,
      id: "watch",
      payload: {
        subscriptionId: "sub",
        extra: true,
      },
    }),
  ).toThrow("Invalid subscription result");
  f.boundary.send(route, {
    kind: "result",
    protocol: PROTOCOL_VERSION,
    id: "watch",
    payload: {
      subscriptionId: "sub",
    },
  });
  const event = (sequence: number, target = "main") =>
    ({
      kind: "event",
      protocol: PROTOCOL_VERSION,
      subscriptionId: "sub",
      source: "backend",
      target,
      event: "changed",
      sequence,
      payload: null,
    }) as ServerMessage;
  const before = f.delivered.length;
  expect(() => f.boundary.send(route, event(2))).toThrow(
    "Invalid event delivery",
  );
  expect(() => f.boundary.send(route, event(1, "other"))).toThrow(
    "Invalid event delivery",
  );
  f.boundary.send(route, event(1));
  f.boundary.send(route, event(2));
  expect(f.delivered).toHaveLength(before + 2);
  f.boundary.send(route, {
    kind: "event",
    protocol: PROTOCOL_VERSION,
    subscriptionId: "unknown",
    source: "backend",
    target: "main",
    event: "changed",
    sequence: 1,
    payload: null,
  });
  expect(f.delivered).toHaveLength(before + 2);
  expect(f.logs).toContain("discarded");
  f.boundary.send(
    {
      ...route,
      documentGeneration: route.documentGeneration + 1,
    },
    event(3),
  );
  expect(f.delivered).toHaveLength(before + 2);
});
