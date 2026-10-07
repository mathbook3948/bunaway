import { afterEach, expect, test } from "bun:test";
import { capabilities, createClient, invoke, listen } from "../../packages/client-sdk/src/index.ts";
import type { WebViewBridge } from "../../packages/client-sdk/src/webview.ts";
import {
  type Capabilities,
  type JsonValue,
  type Message,
  parseMessage,
  PROTOCOL_VERSION,
} from "../../packages/protocol/src/index.ts";

class Bridge implements WebViewBridge {
  readonly listeners = new Set<(event: { data: unknown }) => void>();
  readonly sent: Message[] = [];
  onSend?: (message: Message) => void;

  postMessage(value: unknown): void {
    const message = parseMessage(JSON.stringify(value));
    this.sent.push(message);
    this.onSend?.(message);
  }

  addEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
    this.listeners.delete(listener);
  }

  emit(message: Message): void {
    for (const listener of [...this.listeners]) listener({ data: message });
  }

  hello(major = 1): void {
    this.emit({
      kind: "hello",
      protocol: { major, minor: 0 },
      features: [],
      buildId: "test-backend",
    });
  }

  result(id: string, payload: JsonValue): void {
    this.emit({ kind: "result", protocol: PROTOCOL_VERSION, id, payload });
  }

  requests<K extends Message["kind"]>(kind: K): Extract<Message, { kind: K }>[] {
    return this.sent.filter((message) => message.kind === kind) as Extract<Message, { kind: K }>[];
  }
}

class View {
  document = {};
  readonly chrome = { webview: new Bridge() };
  readonly pageHideListeners = new Set<() => void>();

  addEventListener(_type: "pagehide", listener: () => void): void {
    this.pageHideListeners.add(listener);
  }

  removeEventListener(_type: "pagehide", listener: () => void): void {
    this.pageHideListeners.delete(listener);
  }

  hide(): void {
    for (const listener of [...this.pageHideListeners]) listener();
  }
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const views: View[] = [];

function mount(value: object = new View()): View {
  Object.defineProperty(globalThis, "window", { configurable: true, value });
  if (value instanceof View) views.push(value);
  return value as View;
}

afterEach(() => {
  for (const view of views.splice(0)) view.hide();
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index++) await Promise.resolve();
}

async function reload(
  label: string,
): Promise<typeof import("../../packages/client-sdk/src/index.ts")> {
  const path = new URL(`../../packages/client-sdk/src/index.ts?${label}`, import.meta.url).href;
  return import(path);
}

function last<K extends Message["kind"]>(bridge: Bridge, kind: K): Extract<Message, { kind: K }> {
  const message = bridge.requests(kind).at(-1);
  if (!message) throw new Error(`Missing ${kind} message.`);
  return message;
}

test("imports are lazy and default calls report an unavailable app bridge", async () => {
  Reflect.deleteProperty(globalThis, "window");
  const sdk = await reload("no-window");
  expect(() => sdk.createClient()).toThrow("app WebView");
  await expect(sdk.invoke("memo.read", null)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  await expect(sdk.listen("memo.saved", () => {}, { onError() {} })).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  await expect(sdk.capabilities()).rejects.toMatchObject({ code: "UNSUPPORTED" });

  for (const browser of [{ document: {} }, { document: {}, chrome: { webview: {} } }]) {
    mount(browser);
    await expect(invoke("memo.read", null)).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("bunaway dev"),
    });
  }
  const view = mount();
  await reload("before-first-call");
  expect(view.chrome.webview.sent).toEqual([]);
  expect(view.pageHideListeners.size).toBe(0);
});

test("concurrent direct calls and repeated SDK imports share one handshake and request IDs", async () => {
  const view = mount();
  const bridge = view.chrome.webview;
  const first = invoke<string>("memo.read", null);
  const reloaded = await reload("hot-update");
  const initializerPath = new URL(
    "../../packages/client-sdk/src/default-client.ts?hot-update",
    import.meta.url,
  ).href;
  const initializer: typeof import("../../packages/client-sdk/src/default-client.ts") =
    await import(initializerPath);
  expect(initializer.defaultClient(reloaded.createClient)).toBe(createClient());
  const second = reloaded.invoke("memo.read", null);
  expect(createClient()).toBe(reloaded.createClient());
  expect(bridge.requests("hello")).toHaveLength(1);
  expect(last(bridge, "hello")).toEqual({
    kind: "hello",
    protocol: PROTOCOL_VERSION,
    features: [],
    buildId: "bunaway-client",
  });
  expect(bridge.requests("invoke")).toHaveLength(0);
  expect(bridge.listeners.size).toBe(1);
  expect(view.pageHideListeners.size).toBe(1);
  bridge.hello();
  await flush();
  const requests = bridge.requests("invoke");
  expect(requests).toHaveLength(2);
  const [one, two] = requests;
  if (!one || !two) throw new Error("Missing concurrent requests.");
  expect(one.id).not.toBe(two.id);
  bridge.result(two.id, "second");
  bridge.result(one.id, "first");
  await expect(first).resolves.toBe("first");
  await expect(second).resolves.toBe("second");
});

test("direct event subscriptions dispose independently and capabilities use the same session", async () => {
  const bridge = mount().chrome.webview;
  const received: string[] = [];
  const failures: unknown[] = [];
  const subscribing = listen<string>("memo.saved", (event) => received.push(event.payload), {
    onError: (error) => failures.push(error),
  });
  bridge.hello();
  await flush();
  bridge.result(last(bridge, "listen").id, { subscriptionId: "sub-memo" });
  const unlisten = await subscribing;
  const event: Extract<Message, { kind: "event" }> = {
    kind: "event",
    protocol: PROTOCOL_VERSION,
    subscriptionId: "sub-memo",
    source: "main",
    target: "main",
    event: "memo.saved",
    sequence: 1,
    payload: "saved text",
  };
  bridge.emit(event);
  expect(received).toEqual(["saved text"]);
  const disposing = unlisten();
  await flush();
  bridge.result(last(bridge, "unlisten").id, null);
  await disposing;
  bridge.emit({ ...event, sequence: 2, payload: "late event" });
  expect(received).toEqual(["saved text"]);
  expect(failures).toEqual([]);

  const querying = capabilities();
  await flush();
  expect(last(bridge, "invoke").command).toBe("bunaway.capabilities");
  const support: Capabilities = [
    { name: "storage", support: "supported", permission: "not-required" },
  ];
  bridge.result(last(bridge, "invoke").id, support);
  await expect(querying).resolves.toEqual(support);
  expect(bridge.requests("hello")).toHaveLength(1);
});

test("page exit ends pending calls and subscriptions, removes listeners, and never reconnects", async () => {
  const view = mount();
  const bridge = view.chrome.webview;
  const failures: unknown[] = [];
  const subscribing = listen("memo.saved", () => {}, {
    onError: (error) => failures.push(error),
  });
  bridge.hello();
  await flush();
  bridge.result(last(bridge, "listen").id, { subscriptionId: "sub-memo" });
  const unlisten = await subscribing;
  const pending = invoke("memo.save", "pending text");
  await flush();
  expect(bridge.requests("invoke")).toHaveLength(1);
  view.hide();
  await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  expect(failures).toEqual([{ code: "CANCELLED", message: "Client closed." }]);
  expect(bridge.listeners.size).toBe(0);
  expect(view.pageHideListeners.size).toBe(0);
  await unlisten();
  await expect(invoke("memo.save", "pending text")).rejects.toMatchObject({ code: "CANCELLED" });
  expect(bridge.requests("hello")).toHaveLength(1);
  expect(bridge.requests("invoke")).toHaveLength(1);
});

test("page exit during handshake rejects readiness and waiting calls", async () => {
  const view = mount();
  const pending = invoke("memo.read", null);
  const client = createClient();
  view.hide();
  await expect(client.ready).rejects.toMatchObject({ code: "CANCELLED" });
  await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  expect(view.chrome.webview.requests("invoke")).toHaveLength(0);
  expect(view.chrome.webview.listeners.size).toBe(0);
});

test("synchronous incompatible handshake cleans up and is not retried", async () => {
  const view = mount();
  const bridge = view.chrome.webview;
  bridge.onSend = (message) => {
    if (message.kind === "hello") bridge.hello(2);
  };
  await expect(invoke("memo.read", null)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  await expect(invoke("memo.read", null)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(bridge.requests("hello")).toHaveLength(1);
  expect(bridge.listeners.size).toBe(0);
  expect(view.pageHideListeners.size).toBe(0);
});

test("bridge send failure rejects the call and removes document listeners", async () => {
  const view = mount();
  view.chrome.webview.onSend = () => {
    throw new Error("Broken native bridge.");
  };
  await expect(invoke("memo.read", null)).rejects.toMatchObject({ code: "INTERNAL" });
  expect(view.chrome.webview.listeners.size).toBe(0);
  expect(view.pageHideListeners.size).toBe(0);
});

test("direct calls preserve cancellation before readiness", async () => {
  const bridge = mount().chrome.webview;
  const controller = new AbortController();
  const pending = invoke("memo.save", "cancelled", { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  bridge.hello();
  await flush();
  expect(bridge.requests("invoke")).toHaveLength(0);
  expect(bridge.requests("cancel")).toHaveLength(0);
});

test("each window gets an independent connection and a new document gets a new session", async () => {
  const first = mount();
  const oldClient = createClient();
  first.chrome.webview.hello();
  await oldClient.ready;
  const second = mount();
  const otherClient = createClient();
  expect(otherClient).not.toBe(oldClient);
  second.chrome.webview.hello();
  await otherClient.ready;
  expect(first.chrome.webview.requests("hello")).toHaveLength(1);
  expect(second.chrome.webview.requests("hello")).toHaveLength(1);

  mount(first);
  first.document = {};
  const newClient = createClient();
  expect(newClient).not.toBe(oldClient);
  await expect(oldClient.invoke("memo.read", null)).rejects.toMatchObject({ code: "CANCELLED" });
  first.chrome.webview.hello();
  await newClient.ready;
  expect(first.chrome.webview.requests("hello")).toHaveLength(2);
  expect(first.chrome.webview.listeners.size).toBe(1);
  expect(first.pageHideListeners.size).toBe(1);
});
