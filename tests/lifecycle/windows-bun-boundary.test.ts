import { expect, spyOn, test } from "bun:test";
import { MessageChannel } from "node:worker_threads";
import { Channel, type Packet, type Route } from "#native/windows/bun/channel";
import { createClient } from "@bunaway/client";
import { type CoreSession, createCore } from "@bunaway/core";
import {
  API_LIMITS,
  PROTOCOL_VERSION,
  type ServerMessage,
  type TransportEvent,
} from "@bunaway/protocol";
import { ViewBoundary } from "@bunaway/runtime-bun/view-boundary";

test("Host calls remain BUSY until both Workers acknowledge cancellations, then recover", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "test",
      `${import.meta.dir}/windows-bun-host-capacity.ts`,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  const timeout = setTimeout(() => child.kill(), 10000);
  try {
    expect(await child.exited, await errors).toBe(0);
    expect(await output).toContain("PASS Host capacity recovers");
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) {
      child.kill();
    }
    await child.exited;
  }
}, 15000);

test("Windows boundary rejects canonical overflow before reserving IDs and deadlines win before a scan", async () => {
  const packets: Packet[] = [];
  const output: ServerMessage[] = [];
  let source = "https://app.bunaway.local/index.html";
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
      forward: (packet) => packets.push(packet),
      capacity: () => true,
      deliver: (text) => output.push(JSON.parse(text)),
      log: () => {},
    },
  );
  const hello = {
    kind: "hello",
    protocol: PROTOCOL_VERSION,
    features: [],
    buildId: "test",
  } satisfies ServerMessage;
  boundary.receive(source, JSON.stringify(hello));
  const opened = packets[0];
  if (opened?.kind !== "session-open") {
    throw new Error("Missing session");
  }
  const route = opened.route;
  boundary.send(route, hello);
  packets.length = 0;
  boundary.receive(
    source,
    `{"kind":"invoke","protocol":${JSON.stringify(PROTOCOL_VERSION)},"id":"boundary","command":"echo","payload":[${Array(50000).fill("1e20").join(",")}]}`,
  );
  const rejected = output.at(-1);
  expect(rejected?.kind === "error" && rejected.error.code).toBe(
    "INVALID_ARGUMENT",
  );
  expect(packets).toHaveLength(0);
  boundary.receive(
    source,
    JSON.stringify({
      kind: "invoke",
      protocol: PROTOCOL_VERSION,
      id: "boundary",
      command: "echo",
      payload: null,
    }),
  );
  expect(packets).toHaveLength(1);
  boundary.send(route, {
    kind: "result",
    protocol: PROTOCOL_VERSION,
    id: "boundary",
    payload: "ok",
  });
  for (const kind of [
    "result",
    "error",
  ] as const) {
    const id = `expired-${kind}`;
    boundary.receive(
      source,
      JSON.stringify({
        kind: "invoke",
        protocol: PROTOCOL_VERSION,
        id,
        command: "echo",
        payload: null,
        deadline: Date.now() + 30,
      }),
    );
    await Bun.sleep(45);
    const response: ServerMessage =
      kind === "result"
        ? {
            kind,
            protocol: PROTOCOL_VERSION,
            id,
            payload: "late",
          }
        : {
            kind,
            protocol: PROTOCOL_VERSION,
            id,
            error: {
              code: "INTERNAL",
              message: "late",
            },
          };
    boundary.send(route, response);
    const last = output.at(-1);
    expect(last?.kind === "error" && last.error.code).toBe("TIMEOUT");
    const count = output.length;
    boundary.send(route, response);
    boundary.scanDeadlines();
    expect(output).toHaveLength(count);
    const cancellation = packets.at(-1);
    expect(cancellation?.kind === "client" && cancellation.message.kind).toBe(
      "cancel",
    );
  }
  const count = output.length;
  boundary.send(route, {
    kind: "event",
    protocol: PROTOCOL_VERSION,
    subscriptionId: "ghost",
    event: "changed",
    target: "main",
    source: "backend",
    sequence: 1,
    payload: null,
  });
  expect(output).toHaveLength(count);
  boundary.sameDocument("https://attacker.example/forged");
  source = "https://app.bunaway.local/spa?step=1";
  boundary.sameDocument(source);
  boundary.receive(
    source,
    JSON.stringify({
      kind: "invoke",
      protocol: PROTOCOL_VERSION,
      id: "spa",
      command: "echo",
      payload: null,
    }),
  );
  expect(boundary.matches(route)).toBe(true);
  const invocation = packets.at(-1);
  expect(invocation?.kind === "client" && invocation.message.kind).toBe(
    "invoke",
  );
});

test("Windows boundary keeps accepting settled requests while rejecting retained duplicate IDs", () => {
  const packets: Packet[] = [];
  const output: ServerMessage[] = [];
  const source = "https://app.bunaway.local/index.html";
  const boundary = new ViewBoundary(
    {
      id: "main",
      origins: [
        "https://app.bunaway.local",
      ],
      commands: [
        "echo",
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
      forward: (packet) => packets.push(packet),
      capacity: () => true,
      deliver: (text) => output.push(JSON.parse(text)),
      log: () => {},
    },
  );
  const hello = {
    kind: "hello",
    protocol: PROTOCOL_VERSION,
    features: [],
    buildId: "test",
  } satisfies ServerMessage;
  boundary.receive(source, JSON.stringify(hello));
  const opened = packets[0];
  if (opened?.kind !== "session-open") {
    throw new Error("Missing session");
  }
  boundary.send(opened.route, hello);
  const invoke = (id: string) => {
    packets.length = 0;
    boundary.receive(
      source,
      JSON.stringify({
        kind: "invoke",
        protocol: PROTOCOL_VERSION,
        id,
        command: "echo",
        payload: null,
      }),
    );
    return packets.length === 1;
  };
  const lastId = `id-${API_LIMITS.maxRequestIds + 1}`;
  expect(invoke("held")).toBe(true);
  // Settle more requests than the record holds; none is rejected as BUSY.
  for (let i = 1; i <= API_LIMITS.maxRequestIds + 1; i++) {
    expect(invoke(`id-${i}`)).toBe(true);
    boundary.send(opened.route, {
      kind: "result",
      protocol: PROTOCOL_VERSION,
      id: `id-${i}`,
      payload: null,
    });
  }
  // The pending ID stays protected outside the history; old settled IDs can be reused.
  expect(invoke("held")).toBe(false);
  expect(invoke(lastId)).toBe(false);
  expect(output.at(-1)).toMatchObject({
    kind: "error",
    error: {
      code: "INVALID_ARGUMENT",
      message: "Request ID was already used.",
    },
  });
  expect(invoke("id-1")).toBe(true);
});

test("Core and boundary agree on evicted IDs while the oldest reply is in transit", async () => {
  const source = "https://app.bunaway.local/index.html";
  const view = {
    id: "main",
    origins: [
      new URL(source).origin,
    ],
    commands: [
      "echo",
      "slow",
    ],
    events: [],
    host: {
      permissions: [],
    },
  };
  const hello = {
    kind: "hello" as const,
    protocol: PROTOCOL_VERSION,
    features: [],
    buildId: "test",
  };
  const packets: Packet[] = [];
  const replies: ServerMessage[] = [];
  const output: ServerMessage[] = [];
  let release = () => {};
  let heldReplyReady = () => {};
  const heldReply = new Promise<void>((resolve) => {
    heldReplyReady = resolve;
  });
  const core = await createCore(
    {
      commands: {
        echo: {
          input: {
            const: null,
          },
          output: {
            const: null,
          },
          run: async () => null,
        },
        slow: {
          input: {
            const: null,
          },
          output: {
            const: null,
          },
          run: () =>
            new Promise<null>((resolve) => {
              release = () => resolve(null);
            }),
        },
      },
      events: {},
    },
    {
      policy: {
        version: 1,
        views: [
          view,
        ],
        backend: {
          permissions: [],
        },
      },
      hello,
      platform: "windows",
      backendContext: "backend-test" as Route["context"],
      runtime: {
        createCancellation: () => new AbortController(),
        now: Date.now,
        schedule: (callback, delay) => {
          const timer = setTimeout(callback, delay);
          return () => clearTimeout(timer);
        },
      },
      send: async (_context, message) => {
        replies.push(message);
        if ("id" in message && message.id === "held") {
          heldReplyReady();
        }
      },
      callHost: async () => ({
        kind: "result",
        payload: null,
      }),
    },
  );
  const boundary = new ViewBoundary(view, {
    origin: (text) => new URL(text).origin,
    source: () => source,
    ready: () => true,
    capacity: () => true,
    forward: (packet) => packets.push(packet),
    deliver: (text) => output.push(JSON.parse(text)),
    log: () => {},
  });
  let session: CoreSession | undefined;
  let route: Route | undefined;
  const forward = async () => {
    for (const packet of packets.splice(0)) {
      if (packet.kind === "session-open") {
        route = packet.route;
        session = core.openSession(route.context, route.viewId);
      } else if (packet.kind === "client") {
        await session?.receive(packet.message);
      }
    }
  };
  const deliver = () => {
    if (!route) {
      throw new Error("Missing session route");
    }
    for (const reply of replies.splice(0)) {
      boundary.send(route, reply);
    }
  };
  const invoke = async (id: string, command = "echo") => {
    boundary.receive(
      source,
      JSON.stringify({
        kind: "invoke",
        protocol: PROTOCOL_VERSION,
        id,
        command,
        payload: null,
      }),
    );
    await forward();
  };
  try {
    boundary.receive(source, JSON.stringify(hello));
    await forward();
    deliver();
    await invoke("held", "slow");
    for (let index = 1; index < API_LIMITS.maxRequestIds; index++) {
      await invoke(`fast-${index}`);
      deliver();
    }
    // Core has settled the oldest request, but the UI still awaits its reply.
    release();
    await heldReply;
    await invoke("next");
    deliver();
    // Both layers must forget the same acceptance history, including the old held ID.
    await invoke("held");
    deliver();
    await invoke("fast-1");
    deliver();
    for (const id of [
      "held",
      "fast-1",
    ]) {
      expect(
        output.filter(
          (message) => message.kind === "result" && message.id === id,
        ),
      ).toHaveLength(2);
    }
    expect(boundary.pendingCount).toBe(0);
    expect(output.filter((message) => message.kind === "error")).toHaveLength(
      0,
    );
  } finally {
    release();
    await core.stop();
  }
});

test("Windows boundary uses actual source, issues view-specific contexts and drops revoked delivery", () => {
  const packets: Packet[] = [];
  const output: string[] = [];
  const make = (id: string) =>
    new ViewBoundary(
      {
        id,
        origins: [
          "https://app.bunaway.local",
        ],
        commands: [
          "echo",
        ],
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
        deliver: (text) => output.push(text),
        log: () => {},
      },
    );
  const first = make("first");
  const second = make("second");
  const hello = JSON.stringify({
    kind: "hello",
    protocol: PROTOCOL_VERSION,
    features: [],
    buildId: "test",
  });
  first.receive("https://attacker.example/index.html", hello);
  expect(packets).toHaveLength(0);
  first.receive("https://app.bunaway.local/index.html", hello);
  second.receive("https://app.bunaway.local/index.html", hello);
  const routes = packets
    .filter(
      (
        packet,
      ): packet is Extract<
        Packet,
        {
          kind: "session-open" | "revoke";
        }
      > => packet.kind === "session-open",
    )
    .map((packet) => packet.route);
  expect(routes).toHaveLength(2);
  expect(routes[0]?.context).not.toBe(routes[1]?.context);
  const route = routes[0] as Route;
  first.send(route, {
    kind: "hello",
    protocol: PROTOCOL_VERSION,
    features: [],
    buildId: "test",
  });
  first.receive(
    "https://app.bunaway.local/index.html",
    JSON.stringify({
      kind: "invoke",
      protocol: PROTOCOL_VERSION,
      id: "same-id",
      command: "echo",
      payload: null,
      context: "backend-forged",
    }),
  );
  expect(JSON.parse(output.at(-1) ?? "").error.code).toBe("INVALID_ARGUMENT");
  first.revoke("navigation");
  const previous = output.length;
  first.send(route, {
    kind: "result",
    protocol: PROTOCOL_VERSION,
    id: "same-id",
    payload: "stale",
  });
  expect(output).toHaveLength(previous);
  expect(first.active(route.context)).toBe(false);
});

test.each([
  "ui",
  "main-io",
] as const)(
  "%s revokes all 128 views without consuming lifecycle capacity",
  async (side) => {
    const { port1, port2 } = new MessageChannel();
    const runtime = {
      id: "test",
      generation: "1",
    };
    const failures: unknown[] = [];
    const received: Packet[] = [];
    let release = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    const sender = new Channel(
      port1,
      runtime,
      side,
      () => {},
      (error) => failures.push(error),
    );
    const receiver = new Channel(
      port2,
      runtime,
      side === "ui" ? "main" : "io",
      (packet) => {
        received.push(packet);
        return held;
      },
      (error) => failures.push(error),
    );
    const revoke = (index: number): Packet => {
      const context = `ctx-${index}` as Route["context"];
      return side === "ui"
        ? {
            kind: "revoke",
            route: {
              viewId: `view-${index}`,
              documentGeneration: 0,
              context,
            },
          }
        : {
            kind: "cancel-context",
            context,
          };
    };
    const sends: Promise<void>[] = [];
    try {
      // One synchronous shutdown burst, with every acknowledgement held back.
      for (let index = 0; index < 128; index++) {
        const pending = sender.send(revoke(index));
        void pending.catch((error) => failures.push(error));
        sends.push(pending);
      }
      for (let index = 0; index < 16; index++) {
        const pending = sender.send({
          kind: side === "ui" ? "closing" : "shutdown",
        });
        void pending.catch((error) => failures.push(error));
        sends.push(pending);
      }
      await expect(sender.send(revoke(128))).rejects.toThrow("full");
      await expect(
        sender.send({
          kind: side === "ui" ? "closing" : "shutdown",
        }),
      ).rejects.toThrow("full");
      release();
      await Promise.all(sends);
      expect(received).toHaveLength(144);
      expect(failures).toHaveLength(0);
      // The acknowledged revocation slots can be reused.
      await sender.send(revoke(129));
    } finally {
      release();
      sender.close();
      receiver.close();
      port1.close();
      port2.close();
      await Promise.allSettled(sends);
    }
  },
);

test("Windows channel bounds data, approvals and reserved control slots independently", async () => {
  const { port1, port2 } = new MessageChannel();
  const failures: unknown[] = [];
  const channel = new Channel(
    port1,
    {
      id: "test",
      generation: "1",
    },
    "main",
    () => {},
    (error) => failures.push(error),
  );
  const holds = Array.from(
    {
      length: API_LIMITS.maxPending,
    },
    (_, index) =>
      channel.send({
        kind: "operation",
        context: "backend-test" as Route["context"],
        requestId: `request-${index}`,
        call: {
          operation: "capabilities.get",
          payload: null,
        },
        source: "backend",
      }),
  );
  for (const hold of holds) {
    void hold.catch(() => {});
  }
  await expect(
    channel.send({
      kind: "operation",
      context: "backend-test" as Route["context"],
      requestId: "overflow",
      call: {
        operation: "capabilities.get",
        payload: null,
      },
      source: "backend",
    }),
  ).rejects.toThrow("full");
  const approvals = Array.from(
    {
      length: API_LIMITS.maxPending,
    },
    (_, index) =>
      channel.send({
        kind: "grant",
        context: "backend-test" as Route["context"],
        requestId: `request-${index}`,
        allowed: true,
      }),
  );
  for (const approval of approvals) {
    void approval.catch(() => {});
  }
  await expect(
    channel.send({
      kind: "grant",
      context: "backend-test" as Route["context"],
      requestId: "overflow",
      allowed: true,
    }),
  ).rejects.toThrow("full");
  const controls = Array.from(
    {
      length: 16,
    },
    () =>
      channel.send({
        kind: "shutdown",
      }),
  );
  for (const control of controls) {
    void control.catch(() => {});
  }
  await expect(
    channel.send({
      kind: "shutdown",
    }),
  ).rejects.toThrow("full");
  for (let index = 0; index < holds.length; index++) {
    port2.postMessage({
      runtime: {
        id: "test",
        generation: "1",
      },
      ack: index + 1,
    });
  }
  await Promise.all(holds);
  expect(channel.canSend()).toBe(false); // Approval slots stay reserved after data is accepted.
  port2.postMessage({
    runtime: {
      id: "test",
      generation: "stale",
    },
    sequence: 1,
    packet: {
      kind: "ready",
    },
  });
  await Bun.sleep(10);
  expect(failures).toHaveLength(1);
  channel.close();
  port1.close();
  port2.close();
  const results = await Promise.allSettled([
    ...holds,
    ...approvals,
    ...controls,
  ]);
  for (const result of results.slice(holds.length)) {
    expect(result).toMatchObject({
      status: "rejected",
      reason: {
        message: "Worker channel closed",
      },
    });
  }
});

test("permission and malformed-message errors reach WebView while diagnostics are suppressed", async () => {
  const { port1, port2 } = new MessageChannel();
  const failures: unknown[] = [];
  const output: ServerMessage[] = [];
  const received: Packet[] = [];
  const runtime = {
    id: "test",
    generation: "1",
  };
  port2.on("message", (envelope) => {
    received.push(envelope.packet);
    port2.postMessage({
      runtime,
      ack: envelope.sequence,
    });
  });
  const channel = new Channel(
    port1,
    runtime,
    "ui",
    () => {},
    (error) => failures.push(error),
  );
  const source = "https://app.bunaway.local/index.html";
  const boundary = new ViewBoundary(
    {
      id: "main",
      origins: [
        "https://app.bunaway.local",
      ],
      commands: [
        "echo",
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
      forward: (packet) => channel.notify(packet),
      capacity: (count) => channel.canSend(count),
      deliver: (text) => output.push(JSON.parse(text)),
      log: (event, fields = {}) =>
        channel.notify({
          kind: "diagnostic",
          event,
          fields: {
            ...fields,
          },
        }),
    },
  );
  try {
    const hello = {
      kind: "hello" as const,
      protocol: PROTOCOL_VERSION,
      features: [],
      buildId: "test",
    };
    boundary.receive(source, JSON.stringify(hello));
    await channel.drain();
    const opened = received.find((packet) => packet.kind === "session-open");
    if (opened?.kind !== "session-open") {
      throw new Error("Missing session");
    }
    boundary.send(opened.route, hello);
    await channel.drain();
    // Fill all diagnostic slots in one turn, before any acknowledgements run.
    received.length = 0;
    for (let index = 0; index < 16; index++) {
      channel.notify({
        kind: "diagnostic",
        event: "held",
        fields: {},
      });
    }
    for (const request of [
      {
        kind: "invoke",
        id: "denied-command",
        command: "forbidden",
        payload: null,
      },
      {
        kind: "listen",
        id: "denied-event",
        event: "forbidden",
      },
      {
        kind: "invoke",
        id: "malformed",
        command: "echo",
      },
    ]) {
      boundary.receive(
        source,
        JSON.stringify({
          ...request,
          protocol: PROTOCOL_VERSION,
        }),
      );
    }
    expect(output.slice(-3)).toMatchObject([
      {
        id: "denied-command",
        kind: "error",
        error: {
          code: "PERMISSION_DENIED",
        },
      },
      {
        id: "denied-event",
        kind: "error",
        error: {
          code: "PERMISSION_DENIED",
        },
      },
      {
        id: "malformed",
        kind: "error",
        error: {
          code: "INVALID_ARGUMENT",
        },
      },
    ]);
    await channel.drain();
    expect(received.some((packet) => packet.kind === "client")).toBe(false);
    expect(
      received.some(
        (packet) =>
          packet.kind === "diagnostic" && packet.event === "permission-denied",
      ),
    ).toBe(false);
    await channel.send({
      kind: "diagnostic",
      event: "resumed",
      fields: {},
    });
    expect(received.at(-1)).toMatchObject({
      event: "resumed",
      fields: {
        droppedDiagnostics: 5,
      },
    });
    expect(failures).toHaveLength(0);
  } finally {
    channel.close();
    port1.close();
    port2.close();
  }
});

test("saturated data and diagnostics preserve cancellation, deadlines and lifecycle delivery", async () => {
  const { port1, port2 } = new MessageChannel();
  const failures: unknown[] = [];
  const output: ServerMessage[] = [];
  const runtime = {
    id: "test",
    generation: "1",
  };
  const received: {
    sequence: number;
    packet: Packet;
  }[] = [];
  let hold = false;
  let fullResolve = () => {};
  const full = new Promise<void>((done) => {
    fullResolve = done;
  });
  port2.on("message", (envelope) => {
    received.push(envelope);
    if (!hold) {
      port2.postMessage({
        runtime,
        ack: envelope.sequence,
      });
    }
    if (received.length === API_LIMITS.maxPending + 16 + 1) {
      fullResolve();
    }
  });
  const channel = new Channel(
    port1,
    runtime,
    "ui",
    () => {},
    (error) => failures.push(error),
  );
  const source = "https://app.bunaway.local/index.html";
  const boundary = new ViewBoundary(
    {
      id: "main",
      origins: [
        "https://app.bunaway.local",
      ],
      commands: [
        "echo",
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
      forward: (packet) => channel.notify(packet),
      capacity: (count) => channel.canSend(count),
      deliver: (text) => output.push(JSON.parse(text)),
      log: (event, fields = {}) =>
        channel.notify({
          kind: "diagnostic",
          event,
          fields: {
            ...fields,
          },
        }),
    },
  );
  try {
    const hello = {
      kind: "hello" as const,
      protocol: PROTOCOL_VERSION,
      features: [],
      buildId: "test",
    };
    boundary.receive(source, JSON.stringify(hello));
    await channel.drain();
    const opened = received.find(
      (envelope) => envelope.packet.kind === "session-open",
    )?.packet;
    if (opened?.kind !== "session-open") {
      throw new Error("Missing session");
    }
    boundary.send(opened.route, hello);
    await channel.drain();
    received.length = 0;
    hold = true;
    for (let index = 0; index <= API_LIMITS.maxPending; index++) {
      boundary.receive(
        source,
        JSON.stringify({
          kind: "invoke",
          protocol: PROTOCOL_VERSION,
          id: `request-${index}`,
          command: "echo",
          payload: null,
        }),
      );
    }
    // Even with both data and diagnostics full, lifecycle control must be accepted.
    const closing = channel.send({
      kind: "closing",
    });
    void closing.catch(() => {});
    await full;
    expect(
      received.filter(({ packet }) => packet.kind === "client"),
    ).toHaveLength(API_LIMITS.maxPending);
    expect(
      received.filter(({ packet }) => packet.kind === "diagnostic"),
    ).toHaveLength(16);
    expect(output.at(-1)).toMatchObject({
      kind: "error",
      error: {
        code: "BUSY",
      },
    });
    expect(failures).toHaveLength(0);
    for (let index = 0; index < API_LIMITS.maxPending / 2; index++) {
      boundary.receive(
        source,
        JSON.stringify({
          kind: "cancel",
          protocol: PROTOCOL_VERSION,
          id: `request-${index}`,
        }),
      );
    }
    expect(output.at(-1)).toMatchObject({
      kind: "error",
      error: {
        code: "CANCELLED",
      },
    });
    const clock = spyOn(performance, "now").mockReturnValue(
      performance.now() + API_LIMITS.maxCommandDurationMs + 1,
    );
    try {
      boundary.scanDeadlines();
      boundary.scanDeadlines();
    } finally {
      clock.mockRestore();
    }
    expect(output.at(-1)).toMatchObject({
      kind: "error",
      error: {
        code: "TIMEOUT",
      },
    });
    const outputCount = output.length;
    for (let index = 0; index < API_LIMITS.maxPending * 2; index++) {
      // Repeated and unknown IDs must not consume another cancellation slot.
      boundary.receive(
        source,
        JSON.stringify({
          kind: "cancel",
          protocol: PROTOCOL_VERSION,
          id: `request-${index}`,
        }),
      );
    }
    expect(output).toHaveLength(outputCount);
    boundary.revoke("navigation");
    hold = false;
    for (const envelope of received) {
      port2.postMessage({
        runtime,
        ack: envelope.sequence,
      });
    }
    await closing;
    await channel.drain();
    expect(
      received.filter(
        ({ packet }) =>
          packet.kind === "client" && packet.message.kind === "cancel",
      ),
    ).toHaveLength(API_LIMITS.maxPending);
    expect(received.some(({ packet }) => packet.kind === "revoke")).toBe(true);
    await channel.send({
      kind: "diagnostic",
      event: "resumed",
      fields: {},
    });
    expect(received.at(-1)?.packet).toMatchObject({
      kind: "diagnostic",
      fields: {
        droppedDiagnostics: API_LIMITS.maxPending * 2 + 2 - 16,
      },
    });
    expect(failures).toHaveLength(0);
  } finally {
    channel.close();
    port1.close();
    port2.close();
  }
});

test.each([
  "main",
  "main-io",
] as const)(
  "%s cancels all pending Host calls without consuming shutdown capacity",
  async (side) => {
    const { port1, port2 } = new MessageChannel();
    const runtime = {
      id: "test",
      generation: "1",
    };
    const failures: unknown[] = [];
    const received: Packet[] = [];
    const channel = new Channel(
      port1,
      runtime,
      side,
      () => {},
      (error) => failures.push(error),
    );
    let release = () => {};
    const accepted = new Promise<void>((done) => {
      release = done;
    });
    const receiver = new Channel(
      port2,
      runtime,
      side === "main" ? "ui" : "io",
      (packet) => {
        received.push(packet);
        if (packet.kind === "shutdown") {
          release();
        }
        return accepted;
      },
      (error) => failures.push(error),
    );
    try {
      for (let index = 0; index < API_LIMITS.maxPending; index++) {
        const operation = {
          context: "backend-test" as Route["context"],
          requestId: `host-${index}`,
          call: {
            operation: "capabilities.get",
            payload: null,
          } as const,
        };
        channel.notify(
          side === "main"
            ? {
                ...operation,
                kind: "authorize",
              }
            : {
                ...operation,
                kind: "operation",
                source: "backend",
              },
        );
      }
      for (let index = 0; index < API_LIMITS.maxPending; index++) {
        channel.notify({
          kind: "cancel",
          context: "backend-test" as Route["context"],
          requestId: `host-${index}`,
        });
      }
      await expect(
        channel.send({
          kind: "cancel",
          context: "backend-test" as Route["context"],
          requestId: "overflow",
        }),
      ).rejects.toThrow("full");
      await channel.send({
        kind: "shutdown",
      });
      await channel.drain();
      expect(
        received.filter((packet) => packet.kind === "cancel"),
      ).toHaveLength(API_LIMITS.maxPending);
      expect(received.at(-1)?.kind).toBe("shutdown");
      expect(failures).toHaveLength(0);
      // Acknowledgements release cancellation capacity for subsequent work.
      await channel.send({
        kind: "cancel",
        context: "backend-test" as Route["context"],
        requestId: "next",
      });
      expect(failures).toHaveLength(0);
    } finally {
      release();
      channel.close();
      receiver.close();
      port1.close();
      port2.close();
    }
  },
);

test.each([
  "abort",
  "timeout-scan",
  "timeout-response",
])("%s listen cleanup", async (mode) => {
  const source = "https://app.bunaway.local/index.html";
  const policy = {
    version: 1 as const,
    views: [
      {
        id: "main",
        origins: [
          new URL(source).origin,
        ],
        commands: [],
        events: [
          "changed",
        ],
        host: {
          permissions: [],
        },
      },
    ],
    backend: {
      permissions: [],
    },
  };
  const hello = {
    kind: "hello" as const,
    protocol: PROTOCOL_VERSION,
    features: [],
    buildId: "test",
  };
  const packets: Packet[] = [];
  const replies: ServerMessage[] = [];
  let receive = (_event: TransportEvent) => {};
  let unlistens = 0;
  const viewPolicy = policy.views[0];
  if (!viewPolicy) {
    throw new Error("Missing view policy");
  }
  const boundary = new ViewBoundary(viewPolicy, {
    origin: (text) => new URL(text).origin,
    source: () => source,
    ready: () => true,
    capacity: () => true,
    forward: (packet) => {
      packets.push(packet);
      if (packet.kind === "client" && packet.message.kind === "unlisten") {
        unlistens++;
      }
    },
    deliver: (text) =>
      receive({
        kind: "message",
        text,
      }),
    log: () => {},
  });
  const core = await createCore(
    {
      commands: {},
      events: {
        changed: {},
      },
    },
    {
      policy,
      hello,
      platform: "windows",
      backendContext: "backend-test" as Route["context"],
      runtime: {
        createCancellation: () => new AbortController(),
        now: Date.now,
        schedule: (callback, delay) => {
          const timer = setTimeout(callback, delay);
          return () => clearTimeout(timer);
        },
      },
      send: async (_context, message) => {
        replies.push(message);
      },
      callHost: async () => ({
        kind: "result",
        payload: null,
      }),
    },
  );
  let session: CoreSession | undefined;
  let route: Route | undefined;
  const flush = async () => {
    do {
      for (const packet of packets.splice(0)) {
        if (packet.kind === "session-open") {
          route = packet.route;
          session = core.openSession(route.context, route.viewId);
        } else if (packet.kind === "client") {
          await session?.receive(packet.message);
        }
      }
      for (const reply of replies.splice(0)) {
        if (!route) {
          throw new Error("Missing session");
        }
        boundary.send(route, reply);
      }
      await Bun.sleep(0);
    } while (packets.length || replies.length);
  };
  const client = createClient({
    hello,
    transport: {
      send: async (text) => {
        boundary.receive(source, text);
      },
      subscribe: (listener) => {
        receive = listener;
        return () => {};
      },
      close: async () => {},
    },
  });
  try {
    await flush();
    await client.ready;
    for (let index = 0; index < API_LIMITS.maxSubscriptions; index++) {
      const controller = new AbortController();
      const pending = client
        .listen("changed", () => {}, {
          signal: controller.signal,
          onError: () => {},
        })
        .catch((error: unknown) => error);
      await Bun.sleep(0); // Hold the listen response until after cancellation or timeout.
      if (mode === "abort") {
        controller.abort();
      }
      const clock = spyOn(performance, "now").mockReturnValue(
        performance.now() + API_LIMITS.maxCommandDurationMs + 1,
      );
      try {
        if (mode !== "timeout-response") {
          boundary.scanDeadlines();
          expect(boundary.pendingCount).toBe(1); // Reserve capacity until late cleanup.
        }
        await flush();
        expect(await pending).toMatchObject({
          code: mode === "abort" ? "CANCELLED" : "TIMEOUT",
        });
      } finally {
        clock.mockRestore();
      }
    }
    expect(unlistens).toBe(API_LIMITS.maxSubscriptions);
    expect(boundary.pendingCount).toBe(0);
    const next = client.listen("changed", () => {}, {
      onError: () => {},
    });
    await flush();
    const release = await next;
    const released = release();
    await flush();
    await released;
    expect(unlistens).toBe(API_LIMITS.maxSubscriptions + 1);
  } finally {
    await client.close();
    await core.stop();
  }
});

test("multiple views share cancellation capacity until all cancellation acknowledgements arrive", async () => {
  const { port1, port2 } = new MessageChannel();
  const runtime = {
    id: "test",
    generation: "1",
  };
  const failures: unknown[] = [];
  const received: Packet[] = [];
  const output: ServerMessage[] = [];
  const boundaries: ViewBoundary[] = [];
  let release = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  const channel = new Channel(
    port1,
    runtime,
    "ui",
    () => {},
    (error) => failures.push(error),
  );
  const receiver = new Channel(
    port2,
    runtime,
    "main",
    (packet) => {
      received.push(packet);
      if (packet.kind === "client" && packet.message.kind === "cancel") {
        return held;
      }
    },
    (error) => failures.push(error),
  );
  const source = "https://app.bunaway.local/index.html";
  const hello = {
    kind: "hello" as const,
    protocol: PROTOCOL_VERSION,
    features: [],
    buildId: "test",
  };
  const invoke = (boundary: ViewBoundary, id: string) =>
    boundary.receive(
      source,
      JSON.stringify({
        kind: "invoke",
        protocol: PROTOCOL_VERSION,
        id,
        command: "hold",
        payload: null,
      }),
    );
  try {
    for (const id of [
      "first",
      "second",
    ]) {
      const boundary = new ViewBoundary(
        {
          id,
          origins: [
            new URL(source).origin,
          ],
          commands: [
            "hold",
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
          // Cancellation capacity is shared across views, so include all reservations.
          capacity: (count) =>
            channel.canSend(
              count,
              boundaries.reduce((sum, view) => sum + view.pendingCount, 0),
            ),
          forward: (packet) => channel.notify(packet),
          deliver: (text) => output.push(JSON.parse(text)),
          log: () => {},
        },
      );
      boundaries.push(boundary);
      boundary.receive(source, JSON.stringify(hello));
      await channel.drain();
      const opened = received.find(
        (packet) =>
          packet.kind === "session-open" && packet.route.viewId === id,
      );
      if (opened?.kind !== "session-open") {
        throw new Error("Missing session");
      }
      boundary.send(opened.route, hello);
      for (let index = 0; index < API_LIMITS.maxPending / 2; index++) {
        invoke(boundary, `request-${index}`);
      }
      await channel.drain();
    }
    for (const boundary of boundaries) {
      invoke(boundary, "overflow");
      expect(output.at(-1)).toMatchObject({
        kind: "error",
        error: {
          code: "BUSY",
        },
      });
      boundary.receive(
        source,
        JSON.stringify({
          kind: "cancel",
          protocol: PROTOCOL_VERSION,
          id: "request-0",
        }),
      );
    }
    const clock = spyOn(performance, "now").mockReturnValue(
      performance.now() + API_LIMITS.maxCommandDurationMs + 1,
    );
    try {
      for (const boundary of boundaries) {
        boundary.scanDeadlines();
        boundary.scanDeadlines();
      }
    } finally {
      clock.mockRestore();
    }
    for (const boundary of boundaries) {
      expect(boundary.pendingCount).toBe(0);
      invoke(boundary, "before-ack");
      expect(output.at(-1)).toMatchObject({
        kind: "error",
        error: {
          code: "BUSY",
        },
      });
    }
    // Lifecycle delivery still works while every cancellation slot is occupied.
    await channel.send({
      kind: "closing",
    });
    expect(failures).toHaveLength(0);
    expect(
      received.filter(
        (packet) =>
          packet.kind === "client" && packet.message.kind === "cancel",
      ),
    ).toHaveLength(API_LIMITS.maxPending);
    release();
    await channel.drain();
    for (const boundary of boundaries) {
      invoke(boundary, "after-ack");
    }
    await channel.drain();
    expect(
      received.filter(
        (packet) =>
          packet.kind === "client" &&
          packet.message.kind === "invoke" &&
          packet.message.id === "after-ack",
      ),
    ).toHaveLength(2);
    expect(failures).toHaveLength(0);
  } finally {
    release();
    channel.close();
    receiver.close();
    port1.close();
    port2.close();
  }
});
