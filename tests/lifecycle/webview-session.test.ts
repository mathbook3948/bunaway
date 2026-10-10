import { expect, test } from "bun:test";
import { ViewBoundary } from "#native/windows/bun/boundary";
import type { Packet, Route } from "#native/windows/bun/channel";
import { command } from "@bunaway/backend";
import {
  createClient,
  createWebViewTransport,
  type WebViewBridge,
} from "@bunaway/client";
import { type CoreSession, createCore, type EventEmitter } from "@bunaway/core";
import {
  type Hello,
  type Message,
  type Policy,
  PROTOCOL_VERSION,
  parseMessage,
  type ServerMessage,
  type WireError,
} from "@bunaway/protocol";

test.each([
  "invalid-result",
  "invalid-late-result",
  "client-close",
])(
  "%s closes the WebView host session, cancels commands and removes remote subscriptions",
  async (mode) => {
    const source = "https://app.bunaway.local/index.html";
    const policy: Policy = {
      version: 1,
      views: [
        {
          id: "main",
          origins: [
            new URL(source).origin,
          ],
          commands: [
            "slow",
          ],
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
    const viewPolicy = policy.views[0];
    if (!viewPolicy) {
      throw new Error("Missing view policy");
    }
    const hello = {
      kind: "hello",
      protocol: PROTOCOL_VERSION,
      features: [],
      buildId: "test",
    } satisfies Hello;
    const packets: Packet[] = [];
    const replies: ServerMessage[] = [];
    const sent: Message[] = [];
    const listeners = new Set<(event: { data: unknown }) => void>();
    let corruptListen = false;
    let capacity = true;
    let cancelledCommands = 0;
    let remoteEvents = 0;
    let revocations = 0;
    let events: EventEmitter | undefined;
    let session: CoreSession | undefined;
    let route: Route | undefined;
    const boundary = new ViewBoundary(viewPolicy, {
      origin: (text) => new URL(text).origin,
      source: () => source,
      ready: () => true,
      capacity: () => capacity,
      forward: (packet) => packets.push(packet),
      deliver: (text) => {
        const message = parseMessage(text);
        const delivered =
          corruptListen && message.kind === "result"
            ? {
                ...message,
                payload: null,
              }
            : message;
        for (const listener of listeners) {
          listener({
            data: delivered,
          });
        }
      },
      log: () => {},
    });
    const bridge: WebViewBridge = {
      postMessage: (message) => {
        const text = JSON.stringify(message);
        sent.push(parseMessage(text));
        boundary.receive(source, text);
      },
      addEventListener: (_type, listener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener);
      },
    };
    const core = await createCore(
      {
        commands: {
          slow: command({
            input: {
              const: null,
            },
            output: {
              const: null,
            },
            handle: (_input, context) =>
              new Promise<null>((resolve) => {
                context.signal.addEventListener("abort", () => {
                  cancelledCommands++;
                  resolve(null);
                });
              }),
          }),
        },
        events: {
          changed: {
            type: "string",
          },
        },
        plugins: [
          {
            name: "capture",
            version: "1",
            setup: (context) => {
              events = context.events;
            },
          },
        ],
      },
      {
        policy,
        hello,
        platform: "windows",
        backendContext: "backend" as Route["context"],
        runtime: {
          createCancellation: () => new AbortController(),
          now: Date.now,
          schedule: (callback, delay) => {
            const timer = setTimeout(callback, delay);
            return () => clearTimeout(timer);
          },
        },
        send: async (_context, message) => {
          if (message.kind === "event") {
            remoteEvents++;
          }
          replies.push(message);
        },
        callHost: async () => ({
          kind: "result",
          payload: null,
        }),
      },
    );
    // Pump both directions until neither side has queued work.
    const flush = async () => {
      await Bun.sleep(0);
      do {
        for (const packet of packets.splice(0)) {
          if (packet.kind === "session-open") {
            route = packet.route;
            session = core.openSession(route.context, route.viewId);
          } else if (packet.kind === "client") {
            await session?.receive(packet.message);
          } else if (packet.kind === "revoke") {
            revocations++;
            await session?.close();
          }
        }
        for (const reply of replies.splice(0)) {
          if (!route) {
            throw new Error("Missing route");
          }
          boundary.send(route, reply);
        }
        await Bun.sleep(0);
      } while (packets.length || replies.length);
    };
    const client = createClient({
      hello,
      transport: createWebViewTransport(bridge),
    });
    try {
      await flush();
      await client.ready;
      const errors: WireError[] = [];
      const subscribing = client.listen("changed", () => {}, {
        onError: (error) => errors.push(error),
      });
      await flush();
      const release = await subscribing;
      if (!events || !route) {
        throw new Error("Missing active session");
      }
      await events.emit("changed", "before", {
        kind: "broadcast",
      });
      await flush();
      expect(remoteEvents).toBe(1);
      const invoke = client.invoke("slow", null);
      const invokeFailure = invoke.catch((cause: unknown) => cause);
      await flush();
      if (mode === "client-close") {
        capacity = false;
        await client.close();
      } else {
        const controller = new AbortController();
        const invalid = client.listen("changed", () => {}, {
          signal: controller.signal,
          onError: () => {},
        });
        const listenFailure = invalid.catch((cause: unknown) => cause);
        // Dispatch the request while holding its success response at the host boundary.
        await Bun.sleep(0);
        for (const packet of packets.splice(0)) {
          if (packet.kind === "client") {
            await session?.receive(packet.message);
          }
        }
        if (mode === "invalid-late-result") {
          controller.abort();
          expect(await listenFailure).toMatchObject({
            code: "CANCELLED",
          });
        }
        corruptListen = true;
        capacity = false;
        await flush();
        if (mode === "invalid-result") {
          expect(await listenFailure).toMatchObject({
            code: "INTERNAL",
            message: "Protocol violation.",
          });
        }
      }
      await flush();
      expect(await invokeFailure).toMatchObject({
        code: mode === "client-close" ? "CANCELLED" : "INTERNAL",
      });
      expect(cancelledCommands).toBe(1);
      expect(revocations).toBe(1);
      expect(boundary.matches(route)).toBe(false);
      expect(boundary.pendingCount).toBe(0);
      expect(listeners.size).toBe(0);
      expect(errors).toHaveLength(1);
      await events.emit("changed", "after", {
        kind: "broadcast",
      });
      await flush();
      expect(remoteEvents).toBe(1);
      await release();
      await client.close();
      expect(sent.filter((message) => message.kind === "close")).toHaveLength(
        1,
      );
    } finally {
      await client.close();
      await core.stop();
    }
  },
);

test("WebView close releases local resources even when the bridge rejects the close notification", async () => {
  const listeners = new Set<(event: { data: unknown }) => void>();
  let closes = 0;
  const transport = createWebViewTransport({
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
    postMessage: (message) => {
      if (parseMessage(JSON.stringify(message)).kind === "close") {
        closes++;
        throw new Error("Bridge unavailable");
      }
    },
  });
  let closed = 0;
  transport.subscribe((event) => {
    if (event.kind === "closed") {
      closed++;
    }
  });
  await transport.send(
    JSON.stringify({
      kind: "hello",
      protocol: PROTOCOL_VERSION,
      features: [],
      buildId: "test",
    }),
  );
  await expect(transport.close()).rejects.toThrow("Bridge unavailable");
  await transport.close();
  expect(listeners.size).toBe(0);
  expect(closed).toBe(1);
  expect(closes).toBe(1);
  await expect(transport.send("{}")).rejects.toThrow("closed");
});

test("close validates the document and envelope, and can revoke before negotiation", () => {
  const source = "https://app.bunaway.local/index.html";
  const packets: Packet[] = [];
  const boundary = new ViewBoundary(
    {
      id: "main",
      origins: [
        "https://app.bunaway.local",
      ],
      commands: [],
      events: [],
      host: {
        permissions: [],
      },
    },
    {
      origin: (text) => new URL(text).origin,
      source: () => source,
      ready: () => true,
      capacity: () => true,
      forward: (packet) => packets.push(packet),
      deliver: () => {},
      log: () => {},
    },
  );
  boundary.receive(
    source,
    JSON.stringify({
      kind: "hello",
      protocol: PROTOCOL_VERSION,
      features: [],
      buildId: "test",
    }),
  );
  const opened = packets[0];
  if (opened?.kind !== "session-open") {
    throw new Error("Missing session");
  }
  const close = {
    kind: "close",
    protocol: PROTOCOL_VERSION,
  };
  boundary.receive(
    "https://attacker.example/index.html",
    JSON.stringify(close),
  );
  boundary.receive(
    "https://app.bunaway.local/other.html",
    JSON.stringify(close),
  );
  boundary.receive(
    source,
    JSON.stringify({
      ...close,
      context: "other-context",
    }),
  );
  boundary.receive(
    source,
    JSON.stringify({
      ...close,
      protocol: {
        major: 2,
        minor: 0,
      },
    }),
  );
  expect(boundary.matches(opened.route)).toBe(true);
  expect(packets.filter((packet) => packet.kind === "revoke")).toHaveLength(0);
  boundary.receive(source, JSON.stringify(close));
  boundary.receive(source, JSON.stringify(close));
  expect(boundary.matches(opened.route)).toBe(false);
  expect(packets.filter((packet) => packet.kind === "revoke")).toHaveLength(1);
});
