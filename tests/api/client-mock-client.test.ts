import { expect, setDefaultTimeout, test } from "bun:test";
import { createMockClient } from "@bunaway/client";
import { type CancellationSignal, SDK_READY_FEATURE } from "@bunaway/protocol";
import { deadline, waitFor } from "../fixtures/deadlines";

setDefaultTimeout(deadline("inProcess"));

type Commands = {
  "notes.read": {
    input: {
      key: string;
    };
    output: string;
  };
  "notes.missing": {
    input: null;
    output: null;
  };
};
type Events = {
  "notes.changed": {
    key: string;
  };
  "notes.counted": {
    total: number;
  };
};

test("a mock client negotiates the SDK protocol and runs command handlers", async () => {
  const { client } = createMockClient<Commands, Events>({
    handlers: {
      "notes.read": (input) => `body:${input.key}`,
    },
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

test("a command without a handler fails as unsupported", async () => {
  const { client } = createMockClient<Commands, Events>({
    handlers: {},
  });
  await expect(client.invoke("notes.missing", null)).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  await client.close();
});

test("emit reaches active listeners and stops after the disposer", async () => {
  const { client, emit } = createMockClient<Commands, Events>({
    handlers: {},
  });
  const keys: string[] = [];
  const dispose = await client.listen(
    "notes.changed",
    (event) => {
      keys.push(event.payload.key);
    },
    {
      onError: (error) => {
        throw error;
      },
    },
  );
  emit("notes.changed", {
    key: "a",
  });
  await waitFor(() => keys.length === 1, {
    deadline: "inProcess",
    what: "the event to arrive",
  });
  await dispose();
  emit("notes.changed", {
    key: "b",
  });
  await client.close();
  expect(keys).toEqual([
    "a",
  ]);
});

test("closing the client closes the mock host and aborts running handlers", async () => {
  let signal: CancellationSignal | undefined;
  const { client } = createMockClient<Commands, Events>({
    handlers: {
      "notes.read": (_input, context) => {
        signal = context.signal;
        return new Promise<string>(() => {});
      },
    },
  });
  await client.ready;
  const pending = client.invoke("notes.read", {
    key: "a",
  });
  const settled = pending.then(
    () => "resolved",
    () => "rejected",
  );
  await waitFor(() => signal, {
    deadline: "inProcess",
    what: "the handler to start",
  });
  expect(signal?.aborted).toBe(false);
  await client.close();
  expect(signal?.aborted).toBe(true);
  await expect(settled).resolves.toBe("rejected");
});

test("emit throws for a payload the protocol cannot carry and does nothing after close", async () => {
  const { client, emit } = createMockClient<Commands, Events>({
    handlers: {},
  });
  const received: string[] = [];
  await client.listen(
    "notes.counted",
    () => {
      received.push("counted");
    },
    {
      onError: (error) => {
        throw error;
      },
    },
  );
  expect(() =>
    emit("notes.counted", {
      total: Number.NaN,
    }),
  ).toThrow();
  await client.close();
  expect(() =>
    emit("notes.counted", {
      total: Number.NaN,
    }),
  ).not.toThrow();
  expect(received).toEqual([]);
});
