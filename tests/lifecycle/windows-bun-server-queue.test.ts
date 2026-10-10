import { expect, test } from "bun:test";
import { MessageChannel } from "node:worker_threads";
import { ViewBoundary } from "#native/windows/bun/boundary";
import {
  Channel,
  MAX_WINDOWS,
  type Packet,
  type Route,
  validatePacket,
} from "#native/windows/bun/channel";
import {
  API_LIMITS,
  type Hello,
  type HostContext,
  type Message,
  PROTOCOL_VERSION,
  parseMessage,
  serializeMessage,
  type WireError,
} from "@bunaway/protocol";

const route: Route = {
  viewId: "main",
  documentGeneration: 0,
  context: "ctx-main" as HostContext,
};
const failure: WireError = {
  code: "BUSY",
  message: "Server message queue full.",
};

function server(
  index: number,
  destination = route,
): Extract<
  Packet,
  {
    kind: "server";
  }
> {
  return {
    kind: "server",
    route: destination,
    message: {
      kind: "result",
      protocol: PROTOCOL_VERSION,
      id: `reply-${index}`,
      payload: null,
    },
  };
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve,
  };
}

/** Pair Worker channels and collect failures while a test controls delivery. */
function createChannels(
  receive: (packet: Packet) => void | Promise<void>,
  side: "main" | "ui" | "io" = "main",
  receiveBack: (packet: Packet) => void = () => {},
) {
  const { port1, port2 } = new MessageChannel();
  const runtime = {
    id: "server-queue",
    generation: "1",
  };
  const failures: unknown[] = [];
  const sender = new Channel(port1, runtime, side, receiveBack, (error) =>
    failures.push(error),
  );
  const peers = {
    main: "ui",
    ui: "main",
    io: "main-io",
  } as const;
  const receiver = new Channel(port2, runtime, peers[side], receive, (error) =>
    failures.push(error),
  );
  return {
    sender,
    receiver,
    failures,
    close() {
      sender.close();
      receiver.close();
      port1.close();
      port2.close();
    },
  };
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Worker packet delivery timed out.");
    }
    await Bun.sleep(1);
  }
}

test("server backlog is bounded while Host results and failure controls retain capacity", async () => {
  const gate = deferred();
  const received: Packet[] = [];
  const harness = createChannels((packet) => {
    received.push(packet);
    if (packet.kind === "server") {
      return gate.promise;
    }
  });
  const queueLimit = MAX_WINDOWS * API_LIMITS.maxSubscriptions;
  const count = API_LIMITS.maxPending + queueLimit;
  const sends = Array.from(
    {
      length: count,
    },
    (_, index) => harness.sender.send(server(index)),
  );
  const hostResults: Packet[] = Array.from(
    {
      length: API_LIMITS.maxPending,
    },
    (_, index) => ({
      kind: "host-result",
      context: route.context,
      requestId: `host-${index}`,
      response: {
        kind: "result",
        payload: null,
      },
    }),
  );
  const hostSends = hostResults.map((packet) => harness.sender.send(packet));
  const outcomes = Promise.allSettled([
    ...sends,
    ...hostSends,
  ]);
  try {
    await expect(harness.sender.send(server(count))).rejects.toMatchObject({
      code: "BUSY",
      message: "Server message queue full.",
    });
    await expect(
      harness.sender.send({
        kind: "host-result",
        context: route.context,
        requestId: "host-overflow",
        response: {
          kind: "result",
          payload: null,
        },
      }),
    ).rejects.toThrow("Host response queue full");
    expect(harness.sender.canSend()).toBe(false);
    const controls: Packet[] = [
      {
        kind: "session-failure",
        route,
        error: failure,
      },
      {
        kind: "cancel",
        context: route.context,
        requestId: "host-pending",
      },
      {
        kind: "shutdown",
      },
    ];
    await Promise.all(controls.map((packet) => harness.sender.send(packet)));
    expect(received.filter((packet) => packet.kind === "server")).toHaveLength(
      API_LIMITS.maxPending,
    );
    expect(received.filter((packet) => packet.kind === "host-result")).toEqual(
      [],
    );
    for (const packet of controls) {
      expect(received).toContainEqual(packet);
    }
    expect(harness.failures).toEqual([]);

    gate.resolve();
    const settled = await outcomes;
    expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
    await harness.sender.drain();
    expect(
      received
        .filter((packet) => packet.kind === "server")
        .map((packet) =>
          packet.message.kind === "result" ? packet.message.id : "unexpected",
        ),
    ).toEqual(
      Array.from(
        {
          length: count,
        },
        (_, index) => `reply-${index}`,
      ),
    );
    expect(
      received
        .filter(
          (packet) => packet.kind === "server" || packet.kind === "host-result",
        )
        .slice(-API_LIMITS.maxPending),
    ).toEqual(hostResults);
    expect(harness.sender.canSend()).toBe(true);
    await harness.sender.send(server(count + 1));
    expect(received.at(-1)).toEqual(server(count + 1));
    expect(harness.failures).toEqual([]);
  } finally {
    gate.resolve();
    harness.close();
    await outcomes;
  }
}, 15000);

test.each([
  "ui",
  "io",
] as const)(
  "%s queues Host responses behind active data while cancellation and shutdown stay live",
  async (side) => {
    const gate = deferred();
    const received: Packet[] = [];
    const receivedBack: Packet[] = [];
    const harness = createChannels(
      (packet) => {
        received.push(packet);
        return gate.promise;
      },
      side,
      (packet) => receivedBack.push(packet),
    );
    const activePackets: Packet[] = Array.from(
      {
        length: API_LIMITS.maxPending,
      },
      (_, index) => {
        if (side === "ui") {
          return {
            kind: "client",
            route,
            message: {
              kind: "invoke",
              protocol: PROTOCOL_VERSION,
              id: `active-${index}`,
              command: "test.pending",
              payload: null,
            },
          };
        }
        return {
          kind: "host-response",
          context: route.context,
          requestId: `active-${index}`,
          response: {
            kind: "result",
            payload: null,
          },
        };
      },
    );
    const activeSends = activePackets.map((packet) =>
      harness.sender.send(packet),
    );
    const response: Packet = {
      kind: "host-response",
      context: route.context,
      requestId: "after-data",
      response: {
        kind: "result",
        payload: null,
      },
    };
    let completed = false;
    const completion = harness.sender.send(response).then(() => {
      completed = true;
    });
    const outcomes = Promise.allSettled([
      ...activeSends,
      completion,
    ]);
    try {
      await waitFor(() => received.length === API_LIMITS.maxPending);
      expect(received).toEqual(activePackets);
      expect(completed).toBe(false);
      expect(harness.sender.canSend()).toBe(false);
      const controls: Packet[] = [
        {
          kind: "cancel",
          context: route.context,
          requestId: "active-0",
        },
        {
          kind: "shutdown",
        },
      ];
      await Promise.all(
        controls.map((packet) => harness.receiver.send(packet)),
      );
      expect(receivedBack).toEqual(controls);
      expect(completed).toBe(false);
      expect(received).toHaveLength(API_LIMITS.maxPending);
      expect(harness.failures).toEqual([]);

      gate.resolve();
      expect(
        (await outcomes).every((outcome) => outcome.status === "fulfilled"),
      ).toBe(true);
      await harness.sender.drain();
      expect(completed).toBe(true);
      expect(received.at(-1)).toEqual(response);
      expect(harness.sender.canSend()).toBe(true);
      await harness.sender.send({
        ...response,
        requestId: "recovered",
      });
      expect(received.at(-1)).toMatchObject({
        kind: "host-response",
        requestId: "recovered",
      });
      expect(harness.failures).toEqual([]);
    } finally {
      gate.resolve();
      harness.close();
      await outcomes;
    }
  },
);

test("closing a channel rejects both active and queued server sends", async () => {
  const gate = deferred();
  const received: Packet[] = [];
  const harness = createChannels((packet) => {
    received.push(packet);
    return gate.promise;
  });
  const sends = Array.from(
    {
      length: API_LIMITS.maxPending + 3,
    },
    (_, index) => harness.sender.send(server(index)),
  );
  const outcomes = Promise.allSettled(sends);
  try {
    await waitFor(() => received.length === API_LIMITS.maxPending);
    harness.sender.close();
    const settled = await outcomes;
    expect(settled).toHaveLength(API_LIMITS.maxPending + 3);
    for (const outcome of settled) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason.message).toBe("Worker channel closed");
      }
    }
    gate.resolve();
    await Bun.sleep(5);
    expect(received).toHaveLength(API_LIMITS.maxPending);
    expect(harness.sender.canSend()).toBe(false);
    await expect(harness.sender.send(server(999))).rejects.toThrow(
      "Worker channel closed",
    );
    expect(harness.failures).toEqual([]);
  } finally {
    gate.resolve();
    harness.close();
    await outcomes;
  }
});

test("discardServers releases queued context traffic without delivering it", async () => {
  const gate = deferred();
  const received: Packet[] = [];
  const harness = createChannels((packet) => {
    received.push(packet);
    return gate.promise;
  });
  const discardedRoute: Route = {
    ...route,
    context: "ctx-discarded" as HostContext,
  };
  const active = Array.from(
    {
      length: API_LIMITS.maxPending,
    },
    (_, index) => harness.sender.send(server(index)),
  );
  // These context-specific packets stay queued behind the held active sends.
  const discarded = Array.from(
    {
      length: 3,
    },
    (_, index) => harness.sender.send(server(1000 + index, discardedRoute)),
  );
  const surviving = harness.sender.send(server(2000));
  const outcomes = Promise.allSettled([
    ...active,
    ...discarded,
    surviving,
  ]);
  try {
    await waitFor(() => received.length === API_LIMITS.maxPending);
    harness.sender.discardServers(discardedRoute.context);
    await Promise.all(discarded);
    expect(received).toHaveLength(API_LIMITS.maxPending);
    expect(harness.sender.canSend()).toBe(false);
    gate.resolve();
    expect(
      (await outcomes).every((outcome) => outcome.status === "fulfilled"),
    ).toBe(true);
    await harness.sender.drain();
    const servers = received.filter((packet) => packet.kind === "server");
    expect(servers).toHaveLength(API_LIMITS.maxPending + 1);
    expect(
      servers.some((packet) => packet.route.context === discardedRoute.context),
    ).toBe(false);
    expect(servers.at(-1)).toEqual(server(2000));
    expect(harness.sender.canSend()).toBe(true);
    expect(harness.failures).toEqual([]);
  } finally {
    gate.resolve();
    harness.close();
    await outcomes;
  }
});

test("session failure packets require valid routes, errors and the main-to-UI direction", () => {
  const packet: Packet = {
    kind: "session-failure",
    route,
    error: failure,
  };
  expect(validatePacket(packet, "ui")).toEqual(packet);
  for (const side of [
    "main",
    "io",
    "main-io",
  ] as const) {
    expect(() => validatePacket(packet, side)).toThrow(
      "Invalid Worker direction",
    );
  }
  expect(() =>
    validatePacket(
      {
        kind: "session-failure",
        error: failure,
      },
      "ui",
    ),
  ).toThrow();
  expect(() =>
    validatePacket(
      {
        ...packet,
        route: {
          ...route,
          documentGeneration: -1,
        },
      },
      "ui",
    ),
  ).toThrow();
  expect(() =>
    validatePacket(
      {
        ...packet,
        route: {
          ...route,
          extra: true,
        },
      },
      "ui",
    ),
  ).toThrow();
  expect(() =>
    validatePacket(
      {
        ...packet,
        error: {
          code: "INVALID",
          message: "bad",
        },
      },
      "ui",
    ),
  ).toThrow();
});

test("a boundary failure terminates requests and subscriptions and cannot affect a replacement route", () => {
  const source = "https://app.bunaway.local/index.html";
  const forwarded: Packet[] = [];
  const delivered: Message[] = [];
  const boundary = new ViewBoundary(
    {
      id: "main",
      origins: [
        "https://app.bunaway.local",
      ],
      commands: [
        "echo",
      ],
      events: [
        "changed",
      ],
      host: {
        permissions: [],
      },
    },
    {
      origin: (text) => new URL(text).origin,
      source: () => source,
      ready: () => true,
      forward: (packet) => forwarded.push(packet),
      capacity: () => true,
      deliver: (text) => delivered.push(parseMessage(text)),
      log: () => {},
    },
  );
  const hello = {
    kind: "hello",
    protocol: PROTOCOL_VERSION,
    features: [],
    buildId: "test",
  } satisfies Hello;
  const open = () => {
    boundary.receive(source, serializeMessage(hello));
    const opened = forwarded.at(-2);
    if (opened?.kind !== "session-open") {
      throw new Error("Missing opened boundary route.");
    }
    boundary.send(opened.route, hello);
    return opened.route;
  };
  const original = open();
  boundary.receive(
    source,
    serializeMessage({
      kind: "listen",
      protocol: PROTOCOL_VERSION,
      id: "listen",
      event: "changed",
    }),
  );
  boundary.send(original, {
    kind: "result",
    protocol: PROTOCOL_VERSION,
    id: "listen",
    payload: {
      subscriptionId: "sub-1",
    },
  });
  boundary.receive(
    source,
    serializeMessage({
      kind: "invoke",
      protocol: PROTOCOL_VERSION,
      id: "pending",
      command: "echo",
      payload: null,
    }),
  );
  boundary.receive(
    source,
    serializeMessage({
      kind: "listen",
      protocol: PROTOCOL_VERSION,
      id: "pending-listen",
      event: "changed",
    }),
  );
  const before = delivered.length;
  boundary.fail(
    {
      ...original,
      documentGeneration: original.documentGeneration + 1,
    },
    failure,
  );
  expect(delivered).toHaveLength(before);
  expect(boundary.pendingCount).toBe(2);

  boundary.fail(original, failure);
  expect(delivered.slice(before)).toEqual([
    {
      kind: "error",
      protocol: PROTOCOL_VERSION,
      id: "pending",
      error: failure,
    },
    {
      kind: "error",
      protocol: PROTOCOL_VERSION,
      id: "pending-listen",
      error: failure,
    },
    {
      kind: "subscription-error",
      protocol: PROTOCOL_VERSION,
      subscriptionId: "sub-1",
      error: failure,
    },
  ]);
  expect(forwarded.at(-1)).toEqual({
    kind: "revoke",
    route: original,
  });
  expect(boundary.pendingCount).toBe(0);
  expect(boundary.matches(original)).toBe(false);
  expect(boundary.active(original.context)).toBe(false);
  expect(boundary.generation).toBe(original.documentGeneration + 1);
  boundary.fail(original, failure);
  expect(delivered).toHaveLength(before + 3);

  const replacement = open();
  expect(replacement.context).not.toBe(original.context);
  expect(replacement.documentGeneration).toBe(original.documentGeneration + 1);
  boundary.receive(
    source,
    serializeMessage({
      kind: "invoke",
      protocol: PROTOCOL_VERSION,
      id: "pending",
      command: "echo",
      payload: null,
    }),
  );
  const freshBefore = delivered.length;
  boundary.fail(original, failure);
  boundary.send(original, {
    kind: "result",
    protocol: PROTOCOL_VERSION,
    id: "pending",
    payload: "stale",
  });
  expect(delivered).toHaveLength(freshBefore);
  expect(boundary.matches(replacement)).toBe(true);
  expect(boundary.pendingCount).toBe(1);
  boundary.send(replacement, {
    kind: "result",
    protocol: PROTOCOL_VERSION,
    id: "pending",
    payload: "fresh",
  });
  expect(delivered.at(-1)).toMatchObject({
    kind: "result",
    id: "pending",
    payload: "fresh",
  });
  expect(boundary.pendingCount).toBe(0);
});
