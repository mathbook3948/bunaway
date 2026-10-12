import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { networkPlugin } from "@bunaway/plugin-network/native/windows";
import type { JsonValue } from "@bunaway/protocol";
import { networkOperations } from "#plugins/network/src/contract";

function createAdapter() {
  const platform = networkPlugin.nativePlatforms.windows;
  assert(platform);
  const adapter = platform.create({
    dataRoot: ".",
    capabilities: [],
  });
  assert(adapter.executeUI);
  const call = (operation: string, input: JsonValue, signal?: AbortSignal) => {
    assert(adapter.executeUI);
    return adapter.executeUI(operation, input, "view:test", {
      requestId: crypto.randomUUID(),
      permissions: {
        permissions: [
          operation,
        ],
      },
      ...(signal
        ? {
            signal,
          }
        : {}),
    });
  };
  return {
    adapter,
    call,
  };
}

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    assert(Date.now() < deadline, "Loopback request did not start.");
    await Bun.sleep(2);
  }
}

function server() {
  let targetRequests = 0;
  let waitingRequests = 0;
  let openedSockets = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/redirect") {
        return new Response(null, {
          status: 302,
          headers: {
            location: `http://127.0.0.1:${server.port}/target`,
          },
        });
      }
      if (url.pathname === "/target") {
        targetRequests++;
        return new Response("target");
      }
      if (url.pathname === "/echo") {
        return new Response(request.body, {
          status: 201,
          headers: {
            "x-unicode": "ok",
          },
        });
      }
      if (url.pathname === "/large") {
        return new Response("a".repeat(65537));
      }
      if (url.pathname === "/wait") {
        waitingRequests++;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new Uint8Array([
                  1,
                ]),
              );
            },
          }),
        );
      }
      if (
        url.pathname === "/socket" ||
        url.pathname === "/binary" ||
        url.pathname === "/socket-large"
      ) {
        if (
          server.upgrade(request, {
            data: {
              path: url.pathname,
            },
          })
        ) {
          return;
        }
      }
      return new Response("hello 😀");
    },
    websocket: {
      data: {} as {
        path: string;
      },
      open(socket) {
        openedSockets++;
        if (socket.data.path === "/binary") {
          socket.sendBinary(
            new Uint8Array([
              0,
              255,
              1,
            ]),
          );
        }
        if (socket.data.path === "/socket-large") {
          socket.send("a".repeat(65537));
        }
      },
      message(socket, message) {
        socket.send(message);
      },
    },
  });
  return {
    server,
    url: `http://127.0.0.1:${server.port}`,
    ws: `ws://127.0.0.1:${server.port}`,
    targets: () => targetRequests,
    waits: () => waitingRequests,
    sockets: () => openedSockets,
  };
}

test("generated network adapter preserves binary bodies and never follows HTTP redirects", async () => {
  const local = server();
  const { adapter, call } = createAdapter();
  try {
    const bodyBase64 = Buffer.from([
      0,
      255,
      10,
      65,
    ]).toString("base64");
    const echo = networkOperations.request.output.parse(
      await call("network.request", {
        url: `${local.url}/echo`,
        method: "POST",
        bodyBase64,
      }),
    );
    expect(echo.status).toBe(201);
    expect(echo.bodyBase64).toBe(bodyBase64);
    const redirect = networkOperations.request.output.parse(
      await call("network.request", {
        url: `${local.url}/redirect`,
      }),
    );
    expect(redirect.status).toBe(302);
    expect(local.targets()).toBe(0);
    const head = networkOperations.request.output.parse(
      await call("network.request", {
        url: local.url,
        method: "HEAD",
        maxResponseBytes: 0,
      }),
    );
    expect(head.bodyBase64).toBe("");
    await expect(
      call("network.request", {
        url: `${local.url}/large`,
      }),
    ).rejects.toMatchObject({
      code: "INTERNAL",
    });
    await expect(
      call("network.request", {
        url: local.url,
        maxResponseBytes: 1,
      }),
    ).rejects.toMatchObject({
      code: "INTERNAL",
    });
  } finally {
    await adapter.dispose();
    local.server.stop(true);
  }
});

test("timeout, cancellation, adapter disposal and concurrency bounds release blocked HTTP reads", async () => {
  const local = server();
  const { adapter, call } = createAdapter();
  try {
    await expect(
      call("network.request", {
        url: `${local.url}/wait`,
        timeoutMs: 30,
      }),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    const cancelled = new AbortController();
    const pending = call(
      "network.request",
      {
        url: `${local.url}/wait`,
      },
      cancelled.signal,
    );
    await waitFor(() => local.waits() === 2);
    cancelled.abort();
    await expect(pending).rejects.toMatchObject({
      code: "CANCELLED",
    });
    const waits = Array.from(
      {
        length: 16,
      },
      () =>
        call("network.request", {
          url: `${local.url}/wait`,
        }),
    );
    const observed = Promise.allSettled(waits);
    await Bun.sleep(20);
    await expect(
      call("network.request", {
        url: local.url,
      }),
    ).rejects.toMatchObject({
      code: "BUSY",
    });
    await adapter.dispose();
    await adapter.dispose();
    expect(
      (await observed).every(
        (result) =>
          result.status === "rejected" && result.reason.code === "CANCELLED",
      ),
    ).toBe(true);
    await expect(
      call("network.request", {
        url: local.url,
      }),
    ).rejects.toMatchObject({
      code: "CANCELLED",
    });
  } finally {
    await adapter.dispose();
    local.server.stop(true);
  }
});

test("WebSocket exchanges preserve text and binary, reject redirects and terminate on bounds or cancellation", async () => {
  const local = server();
  const { adapter, call } = createAdapter();
  try {
    const echo = networkOperations.exchange.output.parse(
      await call("network.exchange", {
        url: `${local.ws}/socket`,
        messages: [
          "한글 😀",
          "a & b",
        ],
        receiveCount: 2,
      }),
    );
    expect(echo.messages).toEqual([
      {
        kind: "text",
        text: "한글 😀",
      },
      {
        kind: "text",
        text: "a & b",
      },
    ]);
    expect(echo.close).toMatchObject({
      code: 1000,
      wasClean: true,
    });
    const binary = networkOperations.exchange.output.parse(
      await call("network.exchange", {
        url: `${local.ws}/binary`,
        messages: [],
        receiveCount: 1,
      }),
    );
    expect(binary.messages).toEqual([
      {
        kind: "binary",
        base64: "AP8B",
      },
    ]);
    await expect(
      call("network.exchange", {
        url: `${local.ws}/redirect`,
        messages: [],
        receiveCount: 1,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({
      code: "INTERNAL",
    });
    expect(local.targets()).toBe(0);
    await expect(
      call("network.exchange", {
        url: `${local.ws}/socket-large`,
        messages: [],
        receiveCount: 1,
      }),
    ).rejects.toMatchObject({
      code: "INTERNAL",
    });
    await expect(
      call("network.exchange", {
        url: `${local.ws}/socket`,
        messages: [],
        receiveCount: 1,
        timeoutMs: 30,
      }),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    const priorSockets = local.sockets();
    const cancel = new AbortController();
    const pending = call(
      "network.exchange",
      {
        url: `${local.ws}/socket`,
        messages: [],
        receiveCount: 1,
      },
      cancel.signal,
    );
    await waitFor(() => local.sockets() > priorSockets);
    cancel.abort();
    await expect(pending).rejects.toMatchObject({
      code: "CANCELLED",
    });
  } finally {
    await adapter.dispose();
    local.server.stop(true);
  }
});
