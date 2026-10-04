import { expect, jest, test } from "bun:test";
import { createClient, type Client } from "../../packages/client-sdk/src/index.ts";
import {
  API_LIMITS,
  type Capabilities,
  type Dispose,
  type Hello,
  type JsonValue,
  type Message,
  parseMessage,
  type Transport,
  type TransportEvent,
  type WireError,
} from "../../packages/protocol/src/index.ts";

type Commands = { "notes.read": { input: { key: string }; output: string } };
type Events = { "notes.changed": { key: string } };
type TestClient = Client<Commands, Events>;

class TestTransport implements Transport {
  readonly sent: string[] = [];
  private readonly listeners = new Set<(event: TransportEvent) => void>();
  closed = false;

  send(text: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Transport closed."));
    this.sent.push(text);
    return Promise.resolve();
  }

  subscribe(listener: (event: TransportEvent) => void): Dispose {
    this.listeners.add(listener);
    if (this.closed) queueMicrotask(() => listener({ kind: "closed" }));
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    for (const listener of [...this.listeners]) listener({ kind: "closed" });
    this.listeners.clear();
    return Promise.resolve();
  }

  emit(message: Message | object): void {
    const text = JSON.stringify(message);
    for (const listener of [...this.listeners]) listener({ kind: "message", text });
  }

  emitRaw(text: string): void {
    for (const listener of [...this.listeners]) listener({ kind: "message", text });
  }

  drop(error?: WireError): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of [...this.listeners])
      error === undefined ? listener({ kind: "closed" }) : listener({ kind: "closed", error });
    this.listeners.clear();
  }

  requests<K extends "invoke" | "cancel" | "listen" | "unlisten">(
    kind: K,
  ): Extract<Message, { kind: K }>[] {
    return this.sent
      .map(parseMessage)
      .filter((message): message is Extract<Message, { kind: K }> => message.kind === kind);
  }
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value.");
  return value;
}

const hello: Hello = {
  kind: "hello",
  protocol: { major: 1, minor: 0 },
  features: [],
  buildId: "client",
};
const serverHello: Hello = {
  kind: "hello",
  protocol: { major: 1, minor: 0 },
  features: [],
  buildId: "backend",
};

// Lets queued promise continuations (ready waiters, sends) run to completion.
async function flush(turns = 6): Promise<void> {
  for (let index = 0; index < turns; index++) await Promise.resolve();
}

async function connected(features: string[] = []): Promise<{
  transport: TestTransport;
  client: TestClient;
}> {
  const transport = new TestTransport();
  const client = createClient<Commands, Events>({
    transport,
    hello: { ...hello, features },
  });
  transport.emit({ ...serverHello, features });
  await client.ready;
  return { transport, client };
}

function invokeMessage(transport: TestTransport): Extract<Message, { kind: "invoke" }> {
  return must(transport.requests("invoke").at(-1));
}

function serverResult(id: string, payload: JsonValue) {
  return { kind: "result", protocol: { major: 1, minor: 0 }, id, payload };
}

function serverError(id: string, error: WireError) {
  return { kind: "error", protocol: { major: 1, minor: 0 }, id, error };
}

function eventMessage(subscriptionId: string, sequence: number, payload: JsonValue) {
  return {
    kind: "event",
    protocol: { major: 1, minor: 0 },
    subscriptionId,
    source: "backend",
    target: "main",
    event: "notes.changed",
    sequence,
    payload,
  };
}

test("hello is sent after subscribing and calls wait for ready negotiation", async () => {
  const transport = new TestTransport();
  const client = createClient<Commands, Events>({
    transport,
    hello: { ...hello, features: ["alpha", "shared"] },
  });
  const pending = client.invoke("notes.read", { key: "welcome" });
  // The invoke waits for ready: only the client hello has been sent.
  expect(transport.requests("invoke")).toHaveLength(0);
  const greeting = parseMessage(transport.sent[0] ?? "");
  expect(greeting).toMatchObject({ kind: "hello", buildId: "client" });
  transport.emit({ ...serverHello, features: ["shared", "other"] });
  await expect(client.ready).resolves.toEqual({
    protocol: { major: 1, minor: 0 },
    features: ["shared"],
    buildId: "backend",
  });
  await flush();
  transport.emit(serverResult(invokeMessage(transport).id, "done"));
  await expect(pending).resolves.toBe("done");
});

test("invoke matches results by request id and propagates error responses", async () => {
  const { transport, client } = await connected();
  const first = client.invoke("notes.read", { key: "first" });
  const second = client.invoke("notes.read", { key: "second" });
  await flush();
  const sentRequests = transport.requests("invoke");
  const one = must(sentRequests[0]);
  const two = must(sentRequests[1]);
  expect(one.id).not.toBe(two.id);
  expect(one).toMatchObject({ command: "notes.read", payload: { key: "first" } });
  // Out-of-order responses still match their own request.
  transport.emit(serverResult(two.id, "second-result"));
  await expect(second).resolves.toBe("second-result");
  transport.emit(serverError(one.id, { code: "PERMISSION_DENIED", message: "No access." }));
  await expect(first).rejects.toMatchObject({
    name: "BunawayError",
    code: "PERMISSION_DENIED",
    message: "No access.",
  });
  // A late duplicate result for a finished request is discarded.
  transport.emit(serverResult(two.id, "late"));
  transport.emit(serverResult("request-unknown", "stray"));
  await flush();
  const third = client.invoke("notes.read", { key: "third" });
  await flush();
  transport.emit(serverResult(invokeMessage(transport).id, "third-result"));
  await expect(third).resolves.toBe("third-result");
});

test("major version mismatch fails ready and pending calls and closes the transport", async () => {
  const transport = new TestTransport();
  const client = createClient<Commands, Events>({ transport, hello });
  const pending = client.invoke("notes.read", { key: "x" });
  transport.emit({ ...serverHello, protocol: { major: 2, minor: 0 } });
  await expect(client.ready).rejects.toMatchObject({ code: "UNSUPPORTED" });
  await expect(pending).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(transport.closed).toBe(true);
});

test("ready times out and closes the transport when no hello arrives", async () => {
  // The .rejects matcher never settles under jest fake timers; observe the
  // rejection through a manual handler instead.
  jest.useFakeTimers();
  try {
    const transport = new TestTransport();
    const client = createClient<Commands, Events>({ transport, hello });
    const readyOutcome = client.ready.then(
      () => ({ ok: true }),
      (error: unknown) => ({ ok: false, error }),
    );
    const pendingOutcome = client.invoke("notes.read", { key: "x" }).then(
      () => ({ ok: true }),
      (error: unknown) => ({ ok: false, error }),
    );
    jest.advanceTimersByTime(API_LIMITS.handshakeTimeoutMs);
    expect(await readyOutcome).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
    expect(await pendingOutcome).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
    expect(transport.closed).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});

test("aborting a sent invoke fails it locally and transmits a cancel", async () => {
  const { transport, client } = await connected();
  const controller = new AbortController();
  const pending = client.invoke("notes.read", { key: "x" }, { signal: controller.signal });
  await flush();
  const request = invokeMessage(transport);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  const cancels = transport.requests("cancel");
  expect(cancels).toHaveLength(1);
  expect(cancels[0]).toMatchObject({ kind: "cancel", id: request.id });
  // The late result is discarded; nothing else is reported.
  transport.emit(serverResult(request.id, "late"));
  await flush();
});

test("aborting before ready never sends the request or a cancel", async () => {
  const transport = new TestTransport();
  const client = createClient<Commands, Events>({ transport, hello });
  const controller = new AbortController();
  const pending = client.invoke("notes.read", { key: "x" }, { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  transport.emit(serverHello);
  await client.ready;
  await flush();
  expect(transport.requests("invoke")).toHaveLength(0);
  expect(transport.requests("cancel")).toHaveLength(0);
});

test("an already-aborted signal rejects without touching the transport", async () => {
  const { transport, client } = await connected();
  const controller = new AbortController();
  controller.abort();
  await expect(
    client.invoke("notes.read", { key: "x" }, { signal: controller.signal }),
  ).rejects.toMatchObject({ code: "CANCELLED" });
  await flush();
  expect(transport.requests("invoke")).toHaveLength(0);
});

test("a local deadline fails the call, sends cancel and discards the late result", async () => {
  const { transport, client } = await connected();
  const pending = client.invoke("notes.read", { key: "x" }, { deadline: Date.now() + 20 });
  const expired = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
  await flush();
  const request = invokeMessage(transport);
  expect(request.deadline).toBeGreaterThan(0);
  await new Promise((resolve) => setTimeout(resolve, 40));
  await expired;
  expect(transport.requests("cancel")).toHaveLength(1);
  transport.emit(serverResult(request.id, "late"));
  await flush();
});

test("an already-past deadline rejects without sending the request", async () => {
  const { transport, client } = await connected();
  await expect(
    client.invoke("notes.read", { key: "x" }, { deadline: Date.now() - 1 }),
  ).rejects.toMatchObject({ code: "TIMEOUT" });
  await flush();
  expect(transport.requests("invoke")).toHaveLength(0);
});

test("listen success resolves the release function and delivers ordered events", async () => {
  const { transport, client } = await connected();
  const deliveries: { payload: unknown; sequence: number; source: string; target: string }[] = [];
  const errors: WireError[] = [];
  const released = client.listen(
    "notes.changed",
    (event) =>
      deliveries.push({
        payload: event.payload,
        sequence: event.sequence,
        source: event.source,
        target: event.target,
      }),
    { onError: (error) => errors.push(error) },
  );
  await flush();
  const request = must(transport.requests("listen").at(-1));
  transport.emit(serverResult(request.id, { subscriptionId: "sub-1" }));
  const release = await released;
  transport.emit(eventMessage("sub-1", 1, { key: "a" }));
  transport.emit(eventMessage("sub-1", 2, { key: "b" }));
  expect(deliveries).toEqual([
    { payload: { key: "a" }, sequence: 1, source: "backend", target: "main" },
    { payload: { key: "b" }, sequence: 2, source: "backend", target: "main" },
  ]);
  // Events for other subscriptions do not reach this listener.
  transport.emit(eventMessage("sub-other", 1, { key: "stray" }));
  expect(deliveries).toHaveLength(2);
  void release;
  expect(errors).toHaveLength(0);
});

test("a sequence gap ends the subscription through onError and unlistens", async () => {
  const { transport, client } = await connected();
  const deliveries: number[] = [];
  const errors: WireError[] = [];
  const released = client.listen("notes.changed", (event) => deliveries.push(event.sequence), {
    onError: (error) => errors.push(error),
  });
  await flush();
  const request = must(transport.requests("listen").at(-1));
  transport.emit(serverResult(request.id, { subscriptionId: "sub-1" }));
  await released;
  transport.emit(eventMessage("sub-1", 1, { key: "a" }));
  transport.emit(eventMessage("sub-1", 3, { key: "skipped" }));
  expect(deliveries).toEqual([1]);
  expect(errors).toMatchObject([{ code: "INTERNAL" }]);
  // The abandoned subscription is released host-side; later events are dropped.
  transport.emit(eventMessage("sub-1", 4, { key: "late" }));
  expect(deliveries).toEqual([1]);
  await flush();
  const unlistens = transport.requests("unlisten");
  expect(unlistens.at(-1)).toMatchObject({ subscriptionId: "sub-1" });
});

test("subscription-error delivers the final failure and drops later events", async () => {
  const { transport, client } = await connected();
  const deliveries: number[] = [];
  const errors: WireError[] = [];
  const released = client.listen("notes.changed", (event) => deliveries.push(event.sequence), {
    onError: (error) => errors.push(error),
  });
  await flush();
  const request = must(transport.requests("listen").at(-1));
  transport.emit(serverResult(request.id, { subscriptionId: "sub-1" }));
  const release = await released;
  transport.emit(eventMessage("sub-1", 1, { key: "a" }));
  transport.emit({
    kind: "subscription-error",
    protocol: { major: 1, minor: 0 },
    subscriptionId: "sub-1",
    error: { code: "BUSY", message: "Queue overflow." },
  });
  expect(deliveries).toEqual([1]);
  expect(errors).toEqual([{ code: "BUSY", message: "Queue overflow." }]);
  transport.emit(eventMessage("sub-1", 2, { key: "late" }));
  expect(deliveries).toEqual([1]);
  // Release after the host ended the subscription sends nothing.
  const sentBefore = transport.sent.length;
  await release();
  await flush();
  expect(transport.sent).toHaveLength(sentBefore);
});

test("release sends unlisten, waits for its result and is idempotent", async () => {
  const { transport, client } = await connected();
  const deliveries: number[] = [];
  const released = client.listen("notes.changed", (event) => deliveries.push(event.sequence), {
    onError: () => {},
  });
  await flush();
  const request = must(transport.requests("listen").at(-1));
  transport.emit(serverResult(request.id, { subscriptionId: "sub-1" }));
  const release = await released;
  const done = release();
  const again = release();
  await flush();
  const unlistens = transport.requests("unlisten");
  expect(unlistens).toHaveLength(1);
  expect(unlistens[0]).toMatchObject({ subscriptionId: "sub-1" });
  transport.emit(serverResult(must(unlistens[0]).id, null));
  await done;
  await again;
  // Events arriving after release are never delivered.
  transport.emit(eventMessage("sub-1", 1, { key: "late" }));
  expect(deliveries).toHaveLength(0);
});

test("release on a closed connection completes without a network call", async () => {
  const { transport, client } = await connected();
  const released = client.listen("notes.changed", () => {}, { onError: () => {} });
  await flush();
  const request = must(transport.requests("listen").at(-1));
  transport.emit(serverResult(request.id, { subscriptionId: "sub-1" }));
  const release = await released;
  transport.drop();
  const sentBefore = transport.sent.length;
  await release();
  expect(transport.sent).toHaveLength(sentBefore);
});

test("connection close fails pending calls and ends subscriptions with onError", async () => {
  const { transport, client } = await connected();
  const pending = client.invoke("notes.read", { key: "x" });
  const errors: WireError[] = [];
  const released = client.listen("notes.changed", () => {}, {
    onError: (error) => errors.push(error),
  });
  await flush();
  const request = must(transport.requests("listen").at(-1));
  transport.emit(serverResult(request.id, { subscriptionId: "sub-1" }));
  await released;
  const failure: WireError = { code: "INTERNAL", message: "Pipe lost." };
  transport.drop(failure);
  await expect(pending).rejects.toMatchObject({ code: "INTERNAL", message: "Pipe lost." });
  expect(errors).toEqual([failure]);
  await expect(client.invoke("notes.read", { key: "y" })).rejects.toMatchObject({
    code: "INTERNAL",
    message: "Pipe lost.",
  });
});

test("close rejects pending work once, closes the transport and stays idempotent", async () => {
  const { transport, client } = await connected();
  const pending = client.invoke("notes.read", { key: "x" });
  const errors: WireError[] = [];
  const released = client.listen("notes.changed", () => {}, {
    onError: (error) => errors.push(error),
  });
  await flush();
  const request = must(transport.requests("listen").at(-1));
  transport.emit(serverResult(request.id, { subscriptionId: "sub-1" }));
  await released;
  const first = client.close();
  const second = client.close();
  expect(transport.closed).toBe(true);
  await first;
  await second;
  await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  expect(errors).toMatchObject([{ code: "CANCELLED" }]);
  await expect(client.invoke("notes.read", { key: "y" })).rejects.toMatchObject({
    code: "CANCELLED",
  });
});

test("ready is rejected when the transport closes during handshake", async () => {
  const transport = new TestTransport();
  const client = createClient<Commands, Events>({ transport, hello });
  const pending = client.invoke("notes.read", { key: "x" });
  transport.drop();
  await expect(client.ready).rejects.toMatchObject({ code: "INTERNAL" });
  await expect(pending).rejects.toMatchObject({ code: "INTERNAL" });
});

test("malformed or wrong-direction inbound frames end the connection", async () => {
  for (const raw of ["not json", JSON.stringify({ kind: "invoke" })]) {
    const { transport, client } = await connected();
    const pending = client.invoke("notes.read", { key: "x" });
    await flush();
    transport.emitRaw(raw);
    await expect(pending).rejects.toMatchObject({ code: "INTERNAL" });
    expect(transport.closed).toBe(true);
  }
  const { transport, client } = await connected();
  transport.emit({
    kind: "invoke",
    protocol: { major: 1, minor: 0 },
    id: "evil",
    command: "notes.read",
    payload: {},
  });
  await expect(client.invoke("notes.read", { key: "x" })).rejects.toMatchObject({
    code: "INTERNAL",
  });
  expect(transport.closed).toBe(true);
});

test("frames before the server hello fail the handshake as a violation", async () => {
  const transport = new TestTransport();
  const client = createClient<Commands, Events>({ transport, hello });
  transport.emit(serverResult("request-1", null));
  await expect(client.ready).rejects.toMatchObject({ code: "INTERNAL" });
  expect(transport.closed).toBe(true);
});

test("user listener and onError exceptions do not break the receive loop", async () => {
  const { transport, client } = await connected();
  const deliveries: string[] = [];
  const first = client.listen(
    "notes.changed",
    () => {
      throw new Error("user failure");
    },
    {
      onError: () => {
        throw new Error("user failure");
      },
    },
  );
  const second = client.listen("notes.changed", (event) => deliveries.push(event.payload.key), {
    onError: () => {},
  });
  await flush();
  const listenRequests = transport.requests("listen");
  const one = must(listenRequests[0]);
  const two = must(listenRequests[1]);
  transport.emit(serverResult(one.id, { subscriptionId: "sub-1" }));
  transport.emit(serverResult(two.id, { subscriptionId: "sub-2" }));
  await first;
  await second;
  // Throwing listeners and onError callbacks do not stop delivery elsewhere.
  transport.emit(eventMessage("sub-1", 1, { key: "ignored" }));
  transport.emit(eventMessage("sub-1", 2, { key: "ignored" }));
  transport.emit(eventMessage("sub-2", 1, { key: "kept" }));
  transport.emit({
    kind: "subscription-error",
    protocol: { major: 1, minor: 0 },
    subscriptionId: "sub-1",
    error: { code: "BUSY", message: "overflow" },
  });
  transport.emit(eventMessage("sub-2", 2, { key: "kept-too" }));
  expect(deliveries).toEqual(["kept", "kept-too"]);
  const pending = client.invoke("notes.read", { key: "x" });
  await flush();
  transport.emit(serverResult(invokeMessage(transport).id, "still-works"));
  await expect(pending).resolves.toBe("still-works");
});

test("capabilities calls the reserved command and validates the response", async () => {
  const { transport, client } = await connected();
  const pending = client.capabilities();
  await flush();
  const request = invokeMessage(transport);
  expect(request).toMatchObject({ command: "bunaway.capabilities", payload: null });
  const capabilities: Capabilities = [
    { name: "storage", support: "supported", permission: "denied" },
  ];
  transport.emit(serverResult(request.id, capabilities));
  await expect(pending).resolves.toEqual(capabilities);
  const invalid = client.capabilities();
  await flush();
  const duplicate = invokeMessage(transport);
  transport.emit(
    serverResult(duplicate.id, [
      { name: "storage", support: "supported", permission: "granted" },
      { name: "storage", support: "unsupported", permission: "unknown" },
    ]),
  );
  await expect(invalid).rejects.toMatchObject({ code: "INTERNAL" });
});

test("the pending request limit rejects new calls with BUSY", async () => {
  const { transport, client } = await connected();
  const pending = Array.from({ length: API_LIMITS.maxPending }, () =>
    client.invoke("notes.read", { key: "x" }),
  );
  await expect(client.invoke("notes.read", { key: "overflow" })).rejects.toMatchObject({
    code: "BUSY",
  });
  transport.drop();
  for (const call of pending) await expect(call).rejects.toMatchObject({ code: "INTERNAL" });
});

test("aborting an established subscription releases it", async () => {
  const { transport, client } = await connected();
  const controller = new AbortController();
  const errors: WireError[] = [];
  const released = client.listen("notes.changed", () => {}, {
    signal: controller.signal,
    onError: (error) => errors.push(error),
  });
  await flush();
  const request = must(transport.requests("listen").at(-1));
  transport.emit(serverResult(request.id, { subscriptionId: "sub-1" }));
  await released;
  controller.abort();
  await flush();
  const unlistens = transport.requests("unlisten");
  expect(unlistens).toHaveLength(1);
  expect(unlistens[0]).toMatchObject({ subscriptionId: "sub-1" });
  // An abort-driven release is a normal end, not a subscription failure.
  expect(errors).toHaveLength(0);
});
