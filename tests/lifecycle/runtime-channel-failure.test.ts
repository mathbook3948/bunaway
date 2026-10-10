import { expect, test } from "bun:test";
import { createConnection, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL_VERSION,
  parseMessage,
  parseProcessFrame,
} from "@bunaway/protocol";
import { readJsonLines } from "@bunaway/runtime-bun";

const origin = "https://app.bunaway.local";
const hello = {
  kind: "hello",
  protocol: PROTOCOL_VERSION,
  features: [],
  buildId: "test",
};
const invoke = (id: string, command: string) => ({
  kind: "invoke",
  protocol: PROTOCOL_VERSION,
  id,
  command,
  payload: null,
});

/** A real TCP peer can stop reading or disappear without sending a WebSocket close frame. */
async function stalledPeer(url: string): Promise<Socket> {
  const address = new URL(url);
  const socket = createConnection({
    host: address.hostname,
    port: Number(address.port),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let headers = "";
      const read = (data: Buffer) => {
        headers += data.toString();
        if (!headers.includes("\r\n\r\n")) {
          return;
        }
        socket.off("data", read);
        socket.pause();
        if (headers.startsWith("HTTP/1.1 101 ")) {
          resolve();
        } else {
          reject(new Error("WebSocket upgrade failed"));
        }
      };
      socket.on("error", reject);
      socket.on("data", read);
      socket.once("connect", () =>
        socket.write(
          `GET ${address.pathname} HTTP/1.1\r\nHost: ${address.host}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${Buffer.alloc(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        ),
      );
    });
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/** The test sends only short text frames, with the client mask required by WebSocket. */
function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  expect(payload.length).toBeLessThan(126);
  return Buffer.concat([
    Buffer.from([
      0x81,
      0x80 | payload.length,
      0,
      0,
      0,
      0,
    ]),
    payload,
  ]);
}

function exchange(
  socket: WebSocket,
  value: unknown,
): Promise<ReturnType<typeof parseMessage>> {
  return new Promise((resolve, reject) => {
    socket.onmessage = (event) => {
      try {
        resolve(parseMessage(String(event.data)));
      } catch (error) {
        reject(error);
      }
    };
    socket.onclose = () => reject(new Error("Healthy document disconnected"));
    socket.onerror = () => reject(new Error("Healthy document failed"));
    socket.send(JSON.stringify(value));
  });
}

test.each([
  "abrupt-close",
  "invalid-input",
  "output-backpressure",
] as const)(
  "direct %s cancels only its document and preserves the runtime, other sessions and new grants",
  async (failure) => {
    const entrypoint = fileURLToPath(
      new URL("./channel-failure.fixture.ts", import.meta.url),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        entrypoint,
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timeout = setTimeout(() => child.kill(), 12000);
    const errors = new Response(child.stderr).text();
    const output = readJsonLines(child.stdout)[Symbol.asyncIterator]();
    const sockets: WebSocket[] = [];
    let stalled: Socket | undefined;
    const next = async () => {
      const line = await output.next();
      if (line.done) {
        throw new Error("Unexpected runtime EOF");
      }
      return parseProcessFrame(line.value);
    };
    const send = (body: Record<string, unknown>) =>
      child.stdin.write(
        `${JSON.stringify({
          ...body,
          ipc: PROTOCOL_VERSION,
          runtime: {
            id: "failure-test",
            generation: "1",
          },
        })}\n`,
      );
    const grant = async (context: string) => {
      send({
        kind: "session-open",
        context,
        viewId: "main",
      });
      send({
        kind: "channel-open",
        context,
        nonce: context,
        origin,
      });
      const result = await next();
      if (result.kind !== "channel-ready") {
        throw new Error(`Expected grant, received ${result.kind}`);
      }
      return result.url;
    };
    const connect = async (url: string) => {
      const socket = new WebSocket(url, {
        headers: {
          Origin: origin,
        },
      });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("Connection failed"));
      });
      expect((await exchange(socket, hello)).kind).toBe("hello");
      return socket;
    };
    let sequence = 0;
    const status = async (socket: WebSocket) => {
      const reply = await exchange(
        socket,
        invoke(String(++sequence), "status"),
      );
      if (reply.kind !== "result") {
        throw new Error("Missing status response");
      }
      return reply.payload;
    };
    try {
      send({
        kind: "boot",
        payload: {
          entrypoint,
          buildId: "test",
          backendContext: "backend",
          policy: {
            version: 1,
            backend: {
              permissions: [],
            },
            views: [
              {
                id: "main",
                origins: [
                  origin,
                ],
                commands: [
                  "hold",
                  "large",
                  "status",
                ],
                events: [],
                host: {
                  permissions: [],
                },
              },
            ],
          },
        },
      });
      expect((await next()).kind).toBe("hello");
      send({
        kind: "hello",
        payload: hello,
      });
      const ready = await next();
      expect(ready).toMatchObject({
        kind: "ready",
        pid: child.pid,
      });
      const healthy = await connect(await grant("healthy"));
      const url = await grant("broken");
      stalled = await stalledPeer(url);
      stalled.write(
        Buffer.concat([
          frame(hello),
          frame(invoke("hold", "hold")),
        ]),
      );
      const waitForStatus = async (expected: number[]) => {
        const deadline = Date.now() + 5000;
        let observed = await status(healthy);
        while (
          JSON.stringify(observed) !== JSON.stringify(expected) &&
          Date.now() < deadline
        ) {
          await Bun.sleep(10);
          observed = await status(healthy);
        }
        expect(observed).toEqual(expected);
      };
      await waitForStatus([
        child.pid,
        1,
        0,
      ]);
      if (failure === "abrupt-close") {
        stalled.destroy();
      } else if (failure === "invalid-input") {
        stalled.write(
          frame({
            kind: "not-a-message",
          }),
        );
      } else {
        // 32MiB of valid replies overflow the 2MiB output queue while this peer never reads.
        // 64 requests stay below the independent 128-input and pending-command limits.
        stalled.write(
          Buffer.concat(
            Array.from(
              {
                length: 64,
              },
              (_, i) => frame(invoke(String(i), "large")),
            ),
          ),
        );
      }
      await waitForStatus([
        child.pid,
        1,
        1,
      ]);
      expect(child.exitCode).toBeNull();
      expect(
        (
          await fetch(url.replace("ws:", "http:"), {
            headers: {
              Origin: origin,
            },
          })
        ).status,
      ).toBe(403);
      const replacement = await connect(await grant("replacement"));
      expect(await status(replacement)).toEqual([
        child.pid,
        1,
        1,
      ]);
      // A late native revoke of the already-closed document must remain harmless.
      send({
        kind: "revoke",
        context: "broken",
      });
      expect(await status(healthy)).toEqual([
        child.pid,
        1,
        1,
      ]);
      send({
        kind: "shutdown",
      });
      expect((await next()).kind).toBe("stopping");
      expect(await child.exited).toBe(0);
      expect(await errors).toBe("");
    } finally {
      stalled?.destroy();
      for (const socket of sockets) {
        socket.close();
      }
      clearTimeout(timeout);
      child.kill();
      await child.exited;
    }
  },
  15000,
);
