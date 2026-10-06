import { expect, test } from "bun:test";
import { MessageChannel } from "node:worker_threads";
import { ViewBoundary } from "../../native/windows/bun/boundary.ts";
import { Channel, type Packet, type Route } from "../../native/windows/bun/channel.ts";
import {
  API_LIMITS,
  PROTOCOL_VERSION,
  type ServerMessage,
} from "../../packages/protocol/src/index.ts";

test("Windows boundary rejects canonical overflow before reserving IDs and deadlines win before a scan", async () => {
  const packets: Packet[] = [];
  const output: ServerMessage[] = [];
  let source = "https://app.bunaway.local/index.html";
  const boundary = new ViewBoundary(
    {
      id: "main",
      origins: ["https://app.bunaway.local"],
      commands: ["echo"],
      events: ["changed"],
      host: { log: false, storage: [] },
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
  if (opened?.kind !== "session-open") throw new Error("Missing session");
  const route = opened.route;
  boundary.send(route, hello);
  packets.length = 0;
  boundary.receive(
    source,
    `{"kind":"invoke","protocol":${JSON.stringify(PROTOCOL_VERSION)},"id":"boundary","command":"echo","payload":[${Array(50000).fill("1e20").join(",")}]}`,
  );
  const rejected = output.at(-1);
  expect(rejected?.kind === "error" && rejected.error.code).toBe("INVALID_ARGUMENT");
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
  for (const kind of ["result", "error"] as const) {
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
        ? { kind, protocol: PROTOCOL_VERSION, id, payload: "late" }
        : { kind, protocol: PROTOCOL_VERSION, id, error: { code: "INTERNAL", message: "late" } };
    boundary.send(route, response);
    const last = output.at(-1);
    expect(last?.kind === "error" && last.error.code).toBe("TIMEOUT");
    const count = output.length;
    boundary.send(route, response);
    boundary.scanDeadlines();
    expect(output).toHaveLength(count);
    const cancellation = packets.at(-1);
    expect(cancellation?.kind === "client" && cancellation.message.kind).toBe("cancel");
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
  expect(invocation?.kind === "client" && invocation.message.kind).toBe("invoke");
});

test("Windows boundary uses actual source, issues view-specific contexts and drops revoked delivery", () => {
  const packets: Packet[] = [];
  const output: string[] = [];
  const make = (id: string) =>
    new ViewBoundary(
      {
        id,
        origins: ["https://app.bunaway.local"],
        commands: ["echo"],
        events: [],
        host: { log: false, storage: [] },
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
      (packet): packet is Extract<Packet, { kind: "session-open" | "revoke" }> =>
        packet.kind === "session-open",
    )
    .map((packet) => packet.route);
  expect(routes).toHaveLength(2);
  expect(routes[0]?.context).not.toBe(routes[1]?.context);
  const route = routes[0] as Route;
  first.send(route, { kind: "hello", protocol: PROTOCOL_VERSION, features: [], buildId: "test" });
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

test("Windows channel bounds unacknowledged data and reserved control slots", async () => {
  const { port1, port2 } = new MessageChannel();
  const failures: unknown[] = [];
  const channel = new Channel(
    port1,
    { id: "test", generation: "1" },
    "main",
    () => {},
    (error) => failures.push(error),
  );
  const holds = Array.from({ length: API_LIMITS.maxPending }, (_, index) =>
    channel.send({
      kind: "authorize",
      context: "backend-test" as Route["context"],
      requestId: `request-${index}`,
      call: { operation: "capabilities.get", payload: null },
    }),
  );
  for (const hold of holds) void hold.catch(() => {});
  await expect(
    channel.send({
      kind: "authorize",
      context: "backend-test" as Route["context"],
      requestId: "overflow",
      call: { operation: "capabilities.get", payload: null },
    }),
  ).rejects.toThrow("full");
  const controls = Array.from({ length: 16 }, () => channel.send({ kind: "shutdown" }));
  for (const control of controls) void control.catch(() => {});
  await expect(channel.send({ kind: "shutdown" })).rejects.toThrow("full");
  port2.postMessage({
    runtime: { id: "test", generation: "stale" },
    sequence: 1,
    packet: { kind: "ready" },
  });
  await Bun.sleep(10);
  expect(failures).toHaveLength(1);
  channel.close();
  port1.close();
  port2.close();
  await Promise.allSettled([...holds, ...controls]);
});

test("diagnostic saturation preserves request capacity, BUSY rejection and control delivery", async () => {
  const { port1, port2 } = new MessageChannel();
  const failures: unknown[] = [];
  const output: ServerMessage[] = [];
  const runtime = { id: "test", generation: "1" };
  const received: { sequence: number; packet: Packet }[] = [];
  let hold = false;
  let fullResolve = () => {};
  const full = new Promise<void>((done) => {
    fullResolve = done;
  });
  port2.on("message", (envelope) => {
    received.push(envelope);
    if (!hold) port2.postMessage({ runtime, ack: envelope.sequence });
    if (received.length === API_LIMITS.maxPending + 16 + 1) fullResolve();
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
      origins: ["https://app.bunaway.local"],
      commands: ["echo"],
      events: [],
      host: { log: false, storage: [] },
    },
    {
      origin: (text) => new URL(text).origin,
      source: () => source,
      ready: () => true,
      forward: (packet) => channel.notify(packet),
      capacity: (count) => channel.canSend(count),
      deliver: (text) => output.push(JSON.parse(text)),
      log: (event, fields = {}) =>
        channel.notify({ kind: "diagnostic", event, fields: { ...fields } }),
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
    const opened = received.find((envelope) => envelope.packet.kind === "session-open")?.packet;
    if (opened?.kind !== "session-open") throw new Error("Missing session");
    boundary.send(opened.route, hello);
    await channel.drain();
    received.length = 0;
    hold = true;
    for (let index = 0; index <= API_LIMITS.maxPending; index++)
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
    // Even with both data and diagnostics full, lifecycle control must be accepted.
    const closing = channel.send({ kind: "closing" });
    void closing.catch(() => {});
    await full;
    expect(received.filter(({ packet }) => packet.kind === "client")).toHaveLength(
      API_LIMITS.maxPending,
    );
    expect(received.filter(({ packet }) => packet.kind === "diagnostic")).toHaveLength(16);
    expect(output.at(-1)).toMatchObject({ kind: "error", error: { code: "BUSY" } });
    expect(failures).toHaveLength(0);
    hold = false;
    for (const envelope of received) port2.postMessage({ runtime, ack: envelope.sequence });
    await closing;
    await channel.drain();
    await channel.send({ kind: "diagnostic", event: "resumed", fields: {} });
    expect(received.at(-1)?.packet).toMatchObject({
      kind: "diagnostic",
      fields: { droppedDiagnostics: API_LIMITS.maxPending + 1 - 16 },
    });
    expect(failures).toHaveLength(0);
  } finally {
    channel.close();
    port1.close();
    port2.close();
  }
});
