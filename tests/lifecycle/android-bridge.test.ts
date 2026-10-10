import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { createWebViewTransport, type WebViewBridge } from "@bunaway/client";
import {
  API_LIMITS,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  parseMessage,
} from "@bunaway/protocol";

const portPrefix = "@test-port:";
const nonce = "a611b10a-a5c2-444e-a694-fc17c5f884b4";

test("Android queues its one-use socket setup and reports bounded output failure to the SDK", async () => {
  let socket: Socket | undefined;
  class Socket {
    bufferedAmount = 0;
    sent: string[] = [];
    onopen?: () => void;
    onclose?: () => void;
    onerror?: () => void;
    onmessage?: (event: { data: string }) => void;
    constructor(readonly url: string) {
      socket = this;
    }
    send(text: string) {
      this.sent.push(text);
    }
    close() {
      this.onclose?.();
    }
  }
  const view = {};
  const context = {
    crypto: {
      randomUUID: () => nonce,
    },
    TextEncoder,
    WebSocket: Socket,
    window: {
      top: view,
    },
    chrome: {
      webview: undefined as WebViewBridge | undefined,
    },
    bunawayNative: {
      postMessage: (_text: string) => {},
      onmessage: (_event: { data: string }) => {},
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  context.window.top = context.window;
  runInNewContext(await bridgeSource(), context);
  const bridge = context.chrome.webview;
  if (!bridge) {
    throw new Error("Missing bridge");
  }
  const transport = createWebViewTransport(bridge);
  const events: string[] = [];
  transport.subscribe((event) => events.push(event.kind));
  const hello = JSON.stringify({
    kind: "hello",
    protocol: PROTOCOL_VERSION,
    features: [],
    buildId: "test",
  });
  await transport.send(hello);
  const endpoint = `ws://127.0.0.1:12345/${nonce}`;
  context.bunawayNative.onmessage({
    data: `${portPrefix}socket:${nonce}:${endpoint}`,
  });
  if (!socket) {
    throw new Error("Missing socket");
  }
  expect(socket.url).toBe(endpoint);
  expect(socket.sent).toHaveLength(0);
  socket.onopen?.();
  expect(socket.sent).toEqual([
    hello,
  ]);
  // Exact size handles a valid large ASCII message when the UTF-16 upper bound is too high.
  await transport.send(
    JSON.stringify({
      kind: "invoke",
      protocol: PROTOCOL_VERSION,
      id: "1",
      command: "echo",
      payload: "x".repeat(750000),
    }),
  );
  expect(socket.sent).toHaveLength(2);
  socket.onmessage?.({
    data: hello,
  });
  expect(events).toEqual([
    "message",
  ]);
  socket.bufferedAmount = MAX_MESSAGE_BYTES * 2;
  await expect(transport.send(hello)).rejects.toThrow("queue full");
  expect(events).toEqual([
    "message",
    "closed",
  ]);
  await transport.close();
  socket.onclose?.();
  expect(events).toHaveLength(2);
});

async function bridgeSource() {
  return (
    await Bun.file(
      new URL("../../native/android/bridge.js", import.meta.url),
    ).text()
  )
    .replaceAll("__BUNAWAY_PORT_PREFIX__", portPrefix)
    .replaceAll("__BUNAWAY_MAX_PENDING__", String(API_LIMITS.maxPending))
    .replaceAll("__BUNAWAY_MAX_MESSAGE_BYTES__", String(MAX_MESSAGE_BYTES));
}

test("Android carries validated JSON text directly and retains structured bridge compatibility", async () => {
  const sent: string[] = [];
  let parses = 0;
  let serializations = 0;
  const pageListeners: (() => void)[] = [];
  const view = {};
  const context = {
    crypto: {
      randomUUID: () => nonce,
    },
    window: {
      top: view,
    },
    chrome: {
      webview: undefined as WebViewBridge | undefined,
    },
    bunawayNative: {
      postMessage: (text: string) => sent.push(text),
      onmessage: (_event: { data: string }) => {},
    },
    addEventListener: (type: string, listener: () => void) => {
      if (type === "pagehide") {
        pageListeners.push(listener);
      }
    },
    removeEventListener: () => {},
    JSON: {
      parse: (text: string): unknown => {
        parses++;
        return JSON.parse(text);
      },
      stringify: (value: unknown) => {
        serializations++;
        return JSON.stringify(value);
      },
    },
  };
  context.window.top = context.window;
  runInNewContext(await bridgeSource(), context);
  expect(sent.pop()).toBe(portPrefix + nonce);
  context.bunawayNative.onmessage({
    data: `${portPrefix}fallback:${nonce}`,
  });
  const bridge = context.chrome.webview;
  if (!bridge) {
    throw new Error("Missing Android bridge");
  }
  const transport = createWebViewTransport(bridge);
  const received: string[] = [];
  transport.subscribe((event) => {
    if (event.kind === "message") {
      received.push(event.text);
    }
  });
  const hello = JSON.stringify({
    kind: "hello",
    protocol: PROTOCOL_VERSION,
    features: [],
    buildId: "test",
  });
  const result = JSON.stringify({
    kind: "result",
    protocol: PROTOCOL_VERSION,
    id: "1",
    value: "한글 😀",
  });
  await transport.send(hello);
  await expect(transport.send('{"kind":"invoke"}')).rejects.toThrow();
  context.bunawayNative.onmessage({
    data: result,
  });
  expect(sent).toEqual([
    hello,
  ]);
  expect(received).toEqual([
    result,
  ]);
  expect(parses).toBe(0);
  expect(serializations).toBe(0);

  const structured: unknown[] = [];
  const listener = (event: { data: unknown }) => structured.push(event.data);
  bridge.addEventListener("message", listener);
  context.bunawayNative.onmessage({
    data: result,
  });
  bridge.postMessage(JSON.parse(hello));
  expect(structured).toEqual([
    JSON.parse(result),
  ]);
  expect(parses).toBe(1);
  expect(serializations).toBe(1);
  bridge.removeEventListener("message", listener);
  await transport.close();
  await transport.close();
  expect(parseMessage(sent.at(-1) ?? "").kind).toBe("close");
  context.bunawayNative.onmessage({
    data: result,
  });
  expect(received).toHaveLength(2);
  for (const listener of pageListeners) {
    listener();
  }
  expect(() => bridge.postMessage({})).toThrow("closed");
});

test("Android binds only its document port, flushes in order, bounds setup and closes stale endpoints", async () => {
  type Port = {
    postMessage(text: string): void;
    close(): void;
    onmessage?: (event: { data: string }) => void;
  };
  type Event = {
    data: string;
    ports: Port[];
  };
  const listeners = new Map<string, (event: Event) => void>();
  const native: string[] = [];
  const sent: string[] = [];
  let closed = 0;
  const rejected: Port = {
    postMessage: () => {
      throw new Error("Rejected endpoint used");
    },
    close: () => {
      closed++;
    },
  };
  let endpointClosed = false;
  const endpoint: Port = {
    postMessage: (text) => {
      if (endpointClosed) {
        throw new Error("Closed endpoint used");
      }
      sent.push(text);
    },
    close: () => {
      endpointClosed = true;
      closed++;
    },
  };
  const view = {};
  const context = {
    crypto: {
      randomUUID: () => nonce,
    },
    window: {
      top: view,
    },
    chrome: {
      webview: undefined as WebViewBridge | undefined,
    },
    bunawayNative: {
      postMessage: (text: string) => native.push(text),
      onmessage: (_event: { data: string }) => {},
    },
    addEventListener: (type: string, callback: (event: Event) => void) =>
      listeners.set(type, callback),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  context.window.top = context.window;
  runInNewContext(await bridgeSource(), context);
  const bridge = context.chrome.webview;
  if (!bridge) {
    throw new Error("Missing bridge");
  }
  bridge.postMessage({
    sequence: 0,
  });
  bridge.postMessage({
    sequence: 1,
  });
  expect(native).toEqual([
    portPrefix + nonce,
  ]);
  const transfer = listeners.get("message");
  if (!transfer) {
    throw new Error("Missing transfer listener");
  }
  transfer({
    data: `${portPrefix}old-document`,
    ports: [
      rejected,
    ],
  });
  expect(closed).toBe(1);
  expect(sent).toHaveLength(0);
  transfer({
    data: portPrefix + nonce,
    ports: [
      endpoint,
    ],
  });
  expect(sent.map((text) => JSON.parse(text))).toEqual([
    {
      sequence: 0,
    },
    {
      sequence: 1,
    },
  ]);
  bridge.postMessage({
    sequence: 2,
  });
  expect(sent).toHaveLength(3);
  const received: unknown[] = [];
  bridge.addEventListener("message", (event) => received.push(event.data));
  endpoint.onmessage?.({
    data: '{"reply":true}',
  });
  expect(received).toEqual([
    {
      reply: true,
    },
  ]);
  transfer({
    data: portPrefix + nonce,
    ports: [
      rejected,
    ],
  });
  expect(closed).toBe(2);
  listeners.get("pagehide")?.({
    data: "",
    ports: [],
  });
  expect(closed).toBe(3);
  expect(listeners.has("message")).toBe(false);
  endpoint.onmessage?.({
    data: '{"late":true}',
  });
  expect(received).toHaveLength(1);
  expect(() => bridge.postMessage({})).toThrow("closed");

  const waiting = {
    ...context,
    chrome: {
      webview: undefined as WebViewBridge | undefined,
    },
  };
  runInNewContext(await bridgeSource(), waiting);
  const queued = waiting.chrome.webview;
  if (!queued) {
    throw new Error("Missing waiting bridge");
  }
  for (let i = 0; i < API_LIMITS.maxPending; i++) {
    queued.postMessage({
      i,
    });
  }
  expect(() => queued.postMessage({})).toThrow("queue full");
});
