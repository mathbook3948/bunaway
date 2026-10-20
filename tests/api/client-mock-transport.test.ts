import { expect, setDefaultTimeout, test } from "bun:test";
import {
  type Client,
  createClient,
  createMockTransport,
  type MockHandlers,
  type MockTransport,
} from "@bunaway/client";
import {
  BunawayError,
  type Hello,
  PROTOCOL_VERSION,
  SDK_READY_FEATURE,
  type TransportEvent,
} from "@bunaway/protocol";
import { deadline, waitFor } from "../fixtures/deadlines";

setDefaultTimeout(deadline("inProcess"));

type Commands = {
  "notes.read": {
    input: {
      key: string;
    };
    output: string;
  };
  "notes.fail": {
    input: null;
    output: null;
  };
  "notes.slow": {
    input: null;
    output: string;
  };
};
type Events = {
  "notes.changed": {
    key: string;
  };
};

const hello: Hello = {
  kind: "hello",
  protocol: PROTOCOL_VERSION,
  features: [
    SDK_READY_FEATURE,
  ],
  buildId: "mock-test",
};

function connect(handlers: MockHandlers<Commands>): {
  client: Client<Commands, Events>;
  transport: MockTransport<Events>;
} {
  const transport = createMockTransport<Commands, Events>({
    handlers,
  });
  const client = createClient<Commands, Events>({
    transport,
    hello,
  });
  return {
    client,
    transport,
  };
}

test("a client session negotiates with the mock host and runs command handlers", async () => {
  const { client } = connect({
    "notes.read": (input) => `body:${input.key}`,
  });
  await expect(client.ready).resolves.toMatchObject({
    features: [
      SDK_READY_FEATURE,
    ],
  });
  await expect(
    client.invoke("notes.read", {
      key: "a",
    }),
  ).resolves.toBe("body:a");
  await client.close();
});

test("async handlers resolve and failures map to protocol errors", async () => {
  const { client } = connect({
    "notes.read": async (input) => input.key,
    "notes.fail": () => {
      throw new BunawayError({
        code: "PERMISSION_DENIED",
        message: "nope",
        details: {
          why: "test",
        },
      });
    },
    "notes.slow": () => {
      throw new Error("secret internal detail");
    },
  });
  await expect(
    client.invoke("notes.read", {
      key: "b",
    }),
  ).resolves.toBe("b");
  await expect(client.invoke("notes.fail", null)).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
    message: "nope",
    details: {
      why: "test",
    },
  });
  await expect(client.invoke("notes.slow", null)).rejects.toMatchObject({
    code: "INTERNAL",
    message: "Command failed.",
  });
  await client.close();
});

test("a command without a handler fails as unsupported", async () => {
  const { client } = connect({});
  await expect(
    client.invoke("notes.read", {
      key: "a",
    }),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  for (const inherited of [
    "toString",
    "constructor",
    "hasOwnProperty",
  ]) {
    await expect(
      client.invoke(inherited as "notes.read", null as never),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  }
  await client.close();
});

test("a non-JSON handler result becomes an internal error", async () => {
  const { client } = connect({
    "notes.read": () => undefined as unknown as string,
  });
  await expect(
    client.invoke("notes.read", {
      key: "a",
    }),
  ).rejects.toMatchObject({
    code: "INTERNAL",
    message: "Invalid command response.",
  });
  await client.close();
});

test("cancelling an invoke aborts the handler signal and drops its result", async () => {
  let started = false;
  let aborted = false;
  let release: () => void = () => {};
  const { client, transport } = connect({
    "notes.slow": (_input, context) =>
      new Promise<string>((resolve) => {
        started = true;
        context.signal.addEventListener("abort", () => {
          aborted = true;
        });
        release = () => resolve("late");
      }),
  });
  const frames: string[] = [];
  transport.subscribe((event) => {
    if (event.kind === "message") {
      frames.push(event.text);
    }
  });
  const controller = new AbortController();
  const pending = client.invoke("notes.slow", null, {
    signal: controller.signal,
  });
  await waitFor(() => started, {
    deadline: "inProcess",
    what: "the handler to start",
  });
  controller.abort();
  await expect(pending).rejects.toMatchObject({
    code: "CANCELLED",
  });
  await waitFor(() => aborted, {
    deadline: "inProcess",
    what: "the handler signal to abort",
  });
  const before = frames.length;
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(frames).toHaveLength(before);
  await client.close();
});

test("an emit payload the protocol rejects throws and keeps event numbering", async () => {
  const { client, transport } = connect({});
  const received: number[] = [];
  await client.listen(
    "notes.changed",
    (event) => received.push(event.sequence),
    {
      onError: () => {},
    },
  );
  expect(() =>
    transport.emit("notes.changed", {
      key: undefined,
    } as never),
  ).toThrow();
  transport.emit("notes.changed", {
    key: "ok",
  });
  expect(received).toEqual([
    1,
  ]);
  await client.close();
});

test("an error whose details are not JSON still answers the call", async () => {
  const { client } = connect({
    "notes.fail": () => {
      throw new BunawayError({
        code: "PERMISSION_DENIED",
        message: "m",
        details: {
          fn: () => {},
        } as never,
      });
    },
  });
  await expect(client.invoke("notes.fail", null)).rejects.toMatchObject({
    code: "INTERNAL",
    message: "Command failed.",
  });
  await client.close();
});

test("a hello the protocol rejects fails at construction", () => {
  expect(() =>
    createMockTransport({
      handlers: {},
      features: [
        "not valid!",
      ],
    }),
  ).toThrow();
});

test("emit delivers ordered events to subscribers until they release", async () => {
  const { client, transport } = connect({});
  const received: string[] = [];
  const dispose = await client.listen(
    "notes.changed",
    (event) => received.push(`${event.sequence}:${event.payload.key}`),
    {
      onError: () => {},
    },
  );
  transport.emit("notes.changed", {
    key: "x",
  });
  transport.emit("notes.changed", {
    key: "y",
  });
  expect(received).toEqual([
    "1:x",
    "2:y",
  ]);
  await dispose();
  transport.emit("notes.changed", {
    key: "z",
  });
  expect(received).toHaveLength(2);
  await client.close();
});

test("once releases after the first event", async () => {
  const { client, transport } = connect({});
  const received: string[] = [];
  await client.once(
    "notes.changed",
    (event) => received.push(event.payload.key),
    {
      onError: () => {},
    },
  );
  transport.emit("notes.changed", {
    key: "1",
  });
  transport.emit("notes.changed", {
    key: "2",
  });
  expect(received).toEqual([
    "1",
  ]);
  await client.close();
});

test("closing ends the transport: sends fail, late subscribers see closed, emit is a no-op", async () => {
  const transport = createMockTransport<Commands, Events>({
    handlers: {},
  });
  await transport.close();
  await transport.close();
  await expect(transport.send("{}")).rejects.toThrow("Transport closed.");
  const events: TransportEvent[] = [];
  transport.subscribe((event) => events.push(event));
  await Promise.resolve();
  expect(events).toEqual([
    {
      kind: "closed",
    },
  ]);
  transport.emit("notes.changed", {
    key: "x",
  });
  expect(events).toHaveLength(1);
});

test("closing aborts running handlers and rejects pending calls", async () => {
  let started = false;
  let aborted = false;
  const { client, transport } = connect({
    "notes.slow": (_input, context) =>
      new Promise<string>(() => {
        started = true;
        context.signal.addEventListener("abort", () => {
          aborted = true;
        });
      }),
  });
  const pending = client.invoke("notes.slow", null);
  await waitFor(() => started, {
    deadline: "inProcess",
    what: "the handler to start",
  });
  await transport.close();
  await expect(pending).rejects.toBeInstanceOf(BunawayError);
  expect(aborted).toBe(true);
});

test("an abort listener that throws does not stop close", async () => {
  let started = false;
  const { client, transport } = connect({
    "notes.slow": (_input, context) =>
      new Promise<string>(() => {
        started = true;
        context.signal.addEventListener("abort", () => {
          throw new Error("listener failure");
        });
      }),
  });
  const events: string[] = [];
  transport.subscribe((event) => events.push(event.kind));
  const pending = client.invoke("notes.slow", null);
  await waitFor(() => started, {
    deadline: "inProcess",
    what: "the handler to start",
  });
  await transport.close();
  expect(events).toContain("closed");
  await expect(pending).rejects.toBeInstanceOf(BunawayError);
});

test("the mock host rejects malformed frames from the client", async () => {
  const transport = createMockTransport({
    handlers: {},
  });
  await expect(transport.send("not json")).rejects.toBeDefined();
});

test("a mock host without the readiness feature negotiates without an acknowledgement", async () => {
  const transport = createMockTransport<Commands, Events>({
    handlers: {},
    features: [],
  });
  const client = createClient<Commands, Events>({
    transport,
    hello,
  });
  await expect(client.ready).resolves.toMatchObject({
    features: [],
  });
  await client.close();
});
