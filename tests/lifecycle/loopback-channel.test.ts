import { expect, test } from "bun:test";
import {
  API_LIMITS,
  type HostContext,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  type ServerMessage,
} from "@bunaway/protocol";
import { LoopbackChannel } from "#runtime-bun/loopback-channel";

const origin = "https://app.bunaway.local";
const hello = {
  kind: "hello",
  protocol: PROTOCOL_VERSION,
  features: [],
  buildId: "test",
} as const;
const context = "document-1" as HostContext;

test(
  "unused grants expire while connected documents can initialize the SDK later",
  async () => {
    const idleContext = "idle-document" as HostContext;
    const expired = Promise.withResolvers<void>();
    const received = Promise.withResolvers<void>();
    const channel = new LoopbackChannel({
      receive: async () => {
        received.resolve();
      },
      disconnected: (id) => {
        if (id === context) {
          expired.resolve();
        }
      },
    });
    try {
      const unused = channel.grant(context, origin);
      const socket = await connected(channel.grant(idleContext, origin));
      await expired.promise;
      expect(channel.owns(context)).toBe(false);
      await expect(connected(unused)).rejects.toThrow("rejected");
      expect(channel.owns(idleContext)).toBe(true);
      socket.send(JSON.stringify(hello));
      await received.promise;
    } finally {
      await channel.close();
    }
  },
  API_LIMITS.handshakeTimeoutMs + 5000,
);

test.each([
  [
    "binary",
    new Uint8Array([
      1,
      2,
      3,
    ]),
  ],
  [
    "malformed JSON",
    "{",
  ],
  [
    "oversized text",
    "x".repeat(MAX_MESSAGE_BYTES + 1),
  ],
  [
    "invoke before hello",
    JSON.stringify({
      kind: "invoke",
      protocol: PROTOCOL_VERSION,
      id: "1",
      command: "echo",
      payload: null,
    }),
  ],
] as const)("loopback rejects %s before dispatch", async (_name, input) => {
  const failure = Promise.withResolvers<boolean>();
  let received = false;
  const channel = new LoopbackChannel({
    receive: async () => {
      received = true;
    },
    disconnected: (_id, failed) => failure.resolve(failed),
  });
  try {
    const socket = await connected(channel.grant(context, origin));
    const ended = closed(socket);
    socket.send(input);
    expect(await failure.promise).toBe(true);
    await ended;
    expect(received).toBe(false);
  } finally {
    await channel.close();
  }
});

function connected(url: string, source = origin): Promise<WebSocket> {
  const socket = new WebSocket(url, {
    headers: {
      Origin: source,
    },
  });
  return new Promise((resolve, reject) => {
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error("Connection rejected"));
  });
}

function closed(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.onclose = () => resolve();
  });
}

test("loopback capabilities require the exact origin, are single-use and die with their document", async () => {
  const lost: HostContext[] = [];
  const channel = new LoopbackChannel({
    receive: async () => {},
    disconnected: (id) => lost.push(id),
  });
  try {
    const url = channel.grant(context, origin);
    await expect(connected(url, "https://untrusted.example")).rejects.toThrow(
      "rejected",
    );
    await expect(connected(`${url}?extra=1`)).rejects.toThrow("rejected");
    const response = await fetch(url.replace("ws:", "http:"), {
      headers: {
        Origin: origin,
      },
    });
    expect(response.status).toBe(400);
    // An authenticated request that cannot upgrade consumes the failed grant.
    expect(channel.owns(context)).toBe(false);
    expect(lost).toEqual([
      context,
    ]);
    const fresh = channel.grant(context, origin);
    const socket = await connected(fresh);
    const ended = closed(socket);
    await expect(connected(fresh)).rejects.toThrow("rejected");
    channel.revoke(context);
    await ended;
    expect(lost).toEqual([
      context,
    ]);
    await expect(connected(fresh)).rejects.toThrow("rejected");
    await expect(connected(url)).rejects.toThrow("rejected");
  } finally {
    await channel.close();
    await channel.close();
  }
});

test("loopback keeps async input ordered, validates both directions and bounds pending input", async () => {
  const seen: string[] = [];
  const failures: boolean[] = [];
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const channel = new LoopbackChannel({
    async receive(id, message) {
      expect(id).toBe(context);
      seen.push(message.kind);
      if (message.kind === "hello") {
        entered();
        await gate;
      }
    },
    disconnected: (_id, failed) => {
      failures.push(failed);
    },
  });
  try {
    const socket = await connected(channel.grant(context, origin));
    const ended = closed(socket);
    socket.send(JSON.stringify(hello));
    await started;
    const invoke = JSON.stringify({
      kind: "invoke",
      protocol: PROTOCOL_VERSION,
      id: "1",
      command: "echo",
      payload: null,
    });
    socket.send(invoke);
    expect(seen).toEqual([
      "hello",
    ]);
    // The suspended hello still occupies one of the bounded input slots.
    for (let i = 0; i < API_LIMITS.maxPending; i++) {
      socket.send(invoke);
    }
    await ended;
    release();
    await Promise.resolve();
    expect(failures).toEqual([
      true,
    ]);
    expect(seen).toEqual([
      "hello",
    ]);
    expect(() => channel.send(context, hello as ServerMessage)).toThrow(
      "closed",
    );

    const invalid = await connected(channel.grant(context, origin));
    const invalidEnd = closed(invalid);
    invalid.send(
      JSON.stringify({
        kind: "result",
        protocol: PROTOCOL_VERSION,
        id: "x",
        payload: null,
      }),
    );
    await invalidEnd;
    expect(failures).toEqual([
      true,
      true,
    ]);
  } finally {
    release();
    await channel.close();
  }
});

test("loopback delivers validated Unicode replies and peer closure revokes the Core owner once", async () => {
  const lost: boolean[] = [];
  let disconnected: () => void = () => {};
  const ownerClosed = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  let received: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    received = resolve;
  });
  const channel = new LoopbackChannel({
    receive: async () => {
      received();
    },
    disconnected: (_id, failed) => {
      lost.push(failed);
      disconnected();
    },
  });
  try {
    const socket = await connected(channel.grant(context, origin));
    const ended = closed(socket);
    socket.send(JSON.stringify(hello));
    await ready;
    const reply = new Promise<string>((resolve) => {
      socket.onmessage = (event) => resolve(String(event.data));
    });
    channel.send(context, {
      kind: "result",
      protocol: PROTOCOL_VERSION,
      id: "1",
      payload: "한글 😀",
    });
    expect(JSON.parse(await reply).payload).toBe("한글 😀");
    socket.close();
    await ended;
    await ownerClosed;
    expect(lost).toEqual([
      false,
    ]);
    expect(channel.owns(context)).toBe(false);
  } finally {
    await channel.close();
  }
});
