import { expect, test } from "bun:test";
import { command } from "../../packages/backend-sdk/src/index.ts";
import { createCore } from "../../packages/core/src/index.ts";
import type {
  AppDefinition,
  CoreServices,
  PluginDefinition,
  RuntimeServices,
} from "../../packages/core/src/index.ts";
import {
  API_LIMITS,
  type CancellationController,
  type Hello,
  type HostCall,
  type HostContext,
  type JsonValue,
  type Policy,
  type ServerMessage,
} from "../../packages/protocol/src/index.ts";

function createClock() {
  let current = 1_000_000;
  const timers: { at: number; callback: () => void; cancelled: boolean }[] = [];
  const runtime: RuntimeServices = {
    createCancellation(): CancellationController {
      const listeners = new Set<() => void>();
      let aborted = false;
      return {
        signal: {
          get aborted() {
            return aborted;
          },
          addEventListener(_type, listener) {
            listeners.add(listener);
          },
          removeEventListener(_type, listener) {
            listeners.delete(listener);
          },
        },
        abort() {
          if (aborted) return;
          aborted = true;
          for (const listener of [...listeners]) listener();
        },
      };
    },
    now: () => current,
    schedule(callback, delayMs) {
      const timer = { at: current + delayMs, callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  return {
    runtime,
    get now() {
      return current;
    },
    advance(ms: number) {
      current += ms;
      for (const timer of timers.sort((a, b) => a.at - b.at)) {
        if (!timer.cancelled && timer.at <= current) {
          timer.cancelled = true;
          timer.callback();
        }
      }
    },
  };
}

const policy: Policy = {
  version: 1,
  views: [
    {
      id: "main",
      origins: ["https://app.bunaway.local"],
      commands: ["notes.read", "notes.slow", "notes.emit", "notes.state", "bunaway.capabilities"],
      events: ["notes.changed"],
      host: { log: true, storage: [{ scope: "appData", pathPrefix: "notes", access: ["read"] }] },
    },
    {
      id: "secondary",
      origins: ["https://app.bunaway.local"],
      commands: ["notes.read"],
      events: [],
      host: { log: false, storage: [] },
    },
  ],
  backend: {
    log: true,
    storage: [{ scope: "appData", pathPrefix: "", access: ["read", "write"] }],
  },
};

type Send = (context: HostContext, message: ServerMessage) => Promise<void>;
type CallHost = CoreServices["callHost"];

function createServices(
  clock: ReturnType<typeof createClock>,
  options?: { send?: Send; callHost?: CallHost },
) {
  const sent: { context: HostContext; message: ServerMessage }[] = [];
  const hostCalls: { context: HostContext; call: HostCall }[] = [];
  const services: CoreServices = {
    policy,
    hello: { kind: "hello", protocol: { major: 1, minor: 0 }, features: [], buildId: "test" },
    platform: "windows",
    backendContext: "backend-context" as HostContext,
    runtime: clock.runtime,
    send:
      options?.send ??
      (async (context, message) => {
        sent.push({ context, message });
      }),
    callHost:
      options?.callHost ??
      (async (context, call) => {
        hostCalls.push({ context, call });
        return { kind: "result" as const, payload: null };
      }),
  };
  return { services, sent, hostCalls };
}

const textInput = {
  type: "object",
  properties: { key: { type: "string" } },
  required: ["key"],
  additionalProperties: false,
} as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createApp(overrides?: Partial<AppDefinition>): AppDefinition {
  return {
    commands: {
      "notes.read": command({
        input: textInput,
        output: { type: "string" },
        handle: ({ key }) => `value:${key}`,
      }),
      "notes.slow": command({
        input: { const: null },
        output: { const: null },
        handle: (_input, context) =>
          new Promise<null>((resolve) => {
            context.signal.addEventListener("abort", () => resolve(null));
          }),
      }),
      "notes.emit": command({
        input: { type: "string" },
        output: { const: null },
        async handle(target, context) {
          await context.events.emit("notes.changed", { key: target }, { kind: "broadcast" });
          return null;
        },
      }),
      "notes.state": command({
        input: { type: "string" },
        output: {},
        handle: (key, context) => context.state.get(key) ?? null,
      }),
    },
    events: { "notes.changed": textInput },
    ...overrides,
  };
}

const helloMessage: Hello = {
  kind: "hello",
  protocol: { major: 1, minor: 0 },
  features: [],
  buildId: "ui",
};

async function flush(turns = 20) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

async function openSession(
  services: CoreServices,
  context = "view-context-1" as HostContext,
  viewId = "main",
  app?: AppDefinition,
) {
  const core = await createCore(app ?? createApp(), services);
  const session = core.openSession(context, viewId);
  await session.receive(helloMessage);
  return { core, session };
}

function results(sent: { message: ServerMessage }[], id: string) {
  return sent
    .filter(
      ({ message }) => (message.kind === "result" || message.kind === "error") && message.id === id,
    )
    .map(({ message }) => message);
}

test("command round trip validates input, output and binds the session host context", async () => {
  const clock = createClock();
  const { services, sent, hostCalls } = createServices(clock);
  const app = createApp();
  const { session } = await openSession(services, "view-context-1" as HostContext, "main", app);
  await session.receive({
    kind: "invoke",
    protocol: helloMessage.protocol,
    id: "r1",
    command: "notes.read",
    payload: { key: "a" },
  });
  await flush();
  expect(results(sent, "r1")).toEqual([
    { kind: "result", protocol: helloMessage.protocol, id: "r1", payload: "value:a" },
  ]);

  const hostApp = createApp({
    commands: {
      "notes.read": command({
        input: textInput,
        output: { type: "string" },
        handle: async ({ key }, context) => {
          await context.host.call("storage.readText", {
            scope: "appData",
            path: `notes/${key}.txt`,
          });
          return key;
        },
      }),
    },
  });
  const second = await openSession(services, "view-context-2" as HostContext, "main", hostApp);
  await second.session.receive({
    kind: "invoke",
    protocol: helloMessage.protocol,
    id: "r2",
    command: "notes.read",
    payload: { key: "b" },
  });
  await flush();
  expect(hostCalls).toEqual([
    {
      context: "view-context-2" as HostContext,
      call: {
        operation: "storage.readText",
        payload: { scope: "appData", path: "notes/b.txt" },
      },
    },
  ]);

  await session.receive({
    kind: "invoke",
    protocol: helloMessage.protocol,
    id: "r3",
    command: "notes.read",
    payload: { key: 42 },
  });
  await flush();
  expect(results(sent, "r3")).toMatchObject([
    { kind: "error", error: { code: "INVALID_ARGUMENT" } },
  ]);
});

test("policy blocks commands the view did not allow and unknown commands fail", async () => {
  const clock = createClock();
  const { services, sent } = createServices(clock);
  const { session } = await openSession(services, "ctx-main" as HostContext, "main");
  await session.receive({
    kind: "invoke",
    protocol: helloMessage.protocol,
    id: "r1",
    command: "notes.missing",
    payload: null,
  });
  const secondary = await openSession(services, "ctx-secondary" as HostContext, "secondary");
  await secondary.session.receive({
    kind: "invoke",
    protocol: helloMessage.protocol,
    id: "r2",
    command: "notes.slow",
    payload: null,
  });
  await flush();
  expect(results(sent, "r1")).toMatchObject([
    { kind: "error", error: { code: "INVALID_ARGUMENT" } },
  ]);
  expect(results(sent, "r2")).toMatchObject([
    { kind: "error", error: { code: "PERMISSION_DENIED" } },
  ]);
});

test("requests before hello fail without running the command", async () => {
  const clock = createClock();
  const { services, sent } = createServices(clock);
  let ran = false;
  const app = createApp({
    commands: {
      "notes.read": command({
        input: textInput,
        output: { type: "string" },
        handle: ({ key }) => {
          ran = true;
          return key;
        },
      }),
    },
  });
  const core = await createCore(app, services);
  const session = core.openSession("ctx" as HostContext, "main");
  await session.receive({
    kind: "invoke",
    protocol: helloMessage.protocol,
    id: "r1",
    command: "notes.read",
    payload: { key: "a" },
  });
  await flush();
  expect(ran).toBe(false);
  expect(results(sent, "r1")).toMatchObject([
    { kind: "error", error: { code: "INVALID_ARGUMENT", message: "Protocol handshake required." } },
  ]);
});

test("incompatible hello reports the backend version and suppresses later work", async () => {
  const clock = createClock();
  const { services, sent } = createServices(clock);
  const core = await createCore(createApp(), services);
  const session = core.openSession("ctx" as HostContext, "main");
  await session.receive({
    kind: "hello",
    protocol: { major: 2, minor: 0 },
    features: [],
    buildId: "ui",
  });
  await session.receive({
    kind: "invoke",
    protocol: helloMessage.protocol,
    id: "r1",
    command: "notes.read",
    payload: { key: "a" },
  });
  await flush();
  expect(sent).toEqual([{ context: "ctx" as HostContext, message: services.hello }]);
  expect(core.openSession("ctx" as HostContext, "main")).toBeDefined();
  await core.stop();
});

test("duplicate request IDs and request ID records are bounded", async () => {
  const clock = createClock();
  const { services, sent } = createServices(clock);
  const { session } = await openSession(services);
  const invoke = (id: string) =>
    session.receive({
      kind: "invoke",
      protocol: helloMessage.protocol,
      id,
      command: "notes.missing",
      payload: null,
    });
  await invoke("r1");
  await invoke("r1");
  await flush();
  expect(results(sent, "r1")).toMatchObject([
    { kind: "error", error: { code: "INVALID_ARGUMENT", message: "Unknown command." } },
  ]);
  for (let i = 2; i <= API_LIMITS.maxRequestIds; i++) await invoke(`id-${i}`);
  await invoke("overflow");
  await flush();
  expect(results(sent, "overflow")).toMatchObject([
    { kind: "error", error: { code: "BUSY", message: "Request limit reached." } },
  ]);
});

test("concurrent invokes run without blocking receive and respect the pending limit", async () => {
  const clock = createClock();
  const { services, sent } = createServices(clock);
  const releases = new Map<string, () => void>();
  const app = createApp({
    commands: {
      "notes.slow": command({
        input: { type: "string" },
        output: { type: "string" },
        handle: (key) => new Promise<string>((resolve) => releases.set(key, () => resolve(key))),
      }),
    },
  });
  const { session } = await openSession(services, "ctx" as HostContext, "main", app);
  const invoke = (id: string, key: string) =>
    session.receive({
      kind: "invoke",
      protocol: helloMessage.protocol,
      id,
      command: "notes.slow",
      payload: key,
    });
  await invoke("a", "first");
  await invoke("b", "second");
  releases.get("second")?.();
  await flush();
  expect(results(sent, "b")).toMatchObject([{ kind: "result", payload: "second" }]);
  expect(results(sent, "a")).toEqual([]);
  releases.get("first")?.();
  await flush();
  expect(results(sent, "a")).toMatchObject([{ kind: "result", payload: "first" }]);

  for (let i = 0; i < API_LIMITS.maxPending; i++) await invoke(`p-${i}`, `k-${i}`);
  await invoke("over", "k");
  await flush();
  expect(results(sent, "over")).toMatchObject([
    { kind: "error", error: { code: "BUSY", message: "Pending request limit reached." } },
  ]);
  await session.close();
});

test("cancel ends a pending request with CANCELLED and discards its late result", async () => {
  const clock = createClock();
  const { services, sent } = createServices(clock);
  const gate = deferred<null>();
  let aborted = false;
  const app = createApp({
    commands: {
      "notes.slow": command({
        input: { const: null },
        output: { const: null },
        handle: (_input, context) => {
          context.signal.addEventListener("abort", () => {
            aborted = true;
          });
          return gate.promise;
        },
      }),
    },
  });
  const { session } = await openSession(services, "ctx" as HostContext, "main", app);
  await session.receive({
    kind: "invoke",
    protocol: helloMessage.protocol,
    id: "r1",
    command: "notes.slow",
    payload: null,
  });
  await session.receive({ kind: "cancel", protocol: helloMessage.protocol, id: "r1" });
  await flush();
  expect(aborted).toBe(true);
  expect(results(sent, "r1")).toMatchObject([{ kind: "error", error: { code: "CANCELLED" } }]);
  gate.resolve(null);
  await flush();
  expect(results(sent, "r1")).toHaveLength(1);
});

test("deadlines reject expired requests and cap runtime at the command limit", async () => {
  const clock = createClock();
  const { services, sent } = createServices(clock);
  let runs = 0;
  const app = createApp({
    commands: {
      "notes.slow": command({
        input: { const: null },
        output: { const: null },
        handle: () => {
          runs++;
          return new Promise<null>(() => {});
        },
      }),
    },
  });
  const { session } = await openSession(services, "ctx" as HostContext, "main", app);
  await session.receive({
    kind: "invoke",
    protocol: helloMessage.protocol,
    id: "expired",
    command: "notes.slow",
    payload: null,
    deadline: clock.now - 1,
  });
  await flush();
  expect(runs).toBe(0);
  expect(results(sent, "expired")).toMatchObject([{ kind: "error", error: { code: "TIMEOUT" } }]);

  await session.receive({
    kind: "invoke",
    protocol: helloMessage.protocol,
    id: "hanging",
    command: "notes.slow",
    payload: null,
    deadline: clock.now + 1_000_000,
  });
  await flush();
  expect(runs).toBe(1);
  clock.advance(API_LIMITS.maxCommandDurationMs - 1);
  await flush();
  expect(results(sent, "hanging")).toEqual([]);
  clock.advance(1);
  await flush();
  expect(results(sent, "hanging")).toMatchObject([{ kind: "error", error: { code: "TIMEOUT" } }]);
});

test("state snapshots isolate reads and writes across sessions", async () => {
  const clock = createClock();
  const { services, sent } = createServices(clock);
  const app = createApp({
    state: { note: { text: "initial" } },
    commands: {
      "notes.state": command({
        input: { type: "string" },
        output: {},
        handle: (key, context) => {
          if (key === "seed") {
            const value = { text: "seeded" };
            context.state.set("seeded", value);
            value.text = "corrupted";
            return context.state.get("seeded") ?? null;
          }
          const value = context.state.get(key);
          if (value && typeof value === "object" && !Array.isArray(value)) {
            (value as { text: string }).text = "mutated";
          }
          // Re-reading proves mutations of fetched copies never reach the store.
          return context.state.get(key) ?? null;
        },
      }),
    },
  });
  const { session } = await openSession(services, "ctx" as HostContext, "main", app);
  const invoke = (id: string, key: string) =>
    session.receive({
      kind: "invoke",
      protocol: helloMessage.protocol,
      id,
      command: "notes.state",
      payload: key,
    });
  await invoke("r1", "note");
  await invoke("r2", "note");
  await invoke("r3", "seed");
  await invoke("r4", "seeded");
  await flush();
  expect(results(sent, "r1")).toMatchObject([{ kind: "result", payload: { text: "initial" } }]);
  expect(results(sent, "r2")).toMatchObject([{ kind: "result", payload: { text: "initial" } }]);
  expect(results(sent, "r3")).toMatchObject([{ kind: "result", payload: { text: "seeded" } }]);
  expect(results(sent, "r4")).toMatchObject([{ kind: "result", payload: { text: "seeded" } }]);
});

test("events reach allowed subscriptions in order and stop after unlisten", async () => {
  const clock = createClock();
  const { services, sent } = createServices(clock);
  const { session } = await openSession(services, "ctx-main" as HostContext, "main");
  const secondary = await openSession(services, "ctx-secondary" as HostContext, "secondary");

  await secondary.session.receive({
    kind: "listen",
    protocol: helloMessage.protocol,
    id: "l-denied",
    event: "notes.changed",
  });
  await session.receive({
    kind: "listen",
    protocol: helloMessage.protocol,
    id: "l-unknown",
    event: "notes.other",
  });
  await session.receive({
    kind: "listen",
    protocol: helloMessage.protocol,
    id: "l1",
    event: "notes.changed",
  });
  await flush();
  expect(results(sent, "l-denied")).toMatchObject([
    { kind: "error", error: { code: "PERMISSION_DENIED" } },
  ]);
  expect(results(sent, "l-unknown")).toMatchObject([
    { kind: "error", error: { code: "INVALID_ARGUMENT" } },
  ]);
  expect(results(sent, "l1")).toEqual([
    {
      kind: "result",
      protocol: helloMessage.protocol,
      id: "l1",
      payload: { subscriptionId: "sub-1" },
    },
  ]);

  const emit = (id: string, key: string) =>
    session.receive({
      kind: "invoke",
      protocol: helloMessage.protocol,
      id,
      command: "notes.emit",
      payload: key,
    });
  await emit("e1", "a");
  await emit("e2", "b");
  await flush();
  const events = sent.filter(({ message }) => message.kind === "event");
  expect(events).toEqual([
    {
      context: "ctx-main" as HostContext,
      message: {
        kind: "event",
        protocol: helloMessage.protocol,
        subscriptionId: "sub-1",
        source: "main",
        target: "main",
        event: "notes.changed",
        sequence: 1,
        payload: { key: "a" },
      },
    },
    {
      context: "ctx-main" as HostContext,
      message: {
        kind: "event",
        protocol: helloMessage.protocol,
        subscriptionId: "sub-1",
        source: "main",
        target: "main",
        event: "notes.changed",
        sequence: 2,
        payload: { key: "b" },
      },
    },
  ]);

  await session.receive({
    kind: "unlisten",
    protocol: helloMessage.protocol,
    id: "u1",
    subscriptionId: "sub-1",
  });
  await emit("e3", "c");
  await flush();
  expect(results(sent, "u1")).toMatchObject([{ kind: "result", payload: null }]);
  expect(sent.filter(({ message }) => message.kind === "event")).toHaveLength(2);
});

test("backend emits reach subscriptions with the backend source", async () => {
  const clock = createClock();
  const { services, sent } = createServices(clock);
  let emit: ((payload: JsonValue) => Promise<void>) | undefined;
  const plugin: PluginDefinition = {
    name: "emitter",
    version: "1",
    events: { "notes.changed": textInput },
    setup(context) {
      emit = (payload) => context.events.emit("notes.changed", payload, { kind: "broadcast" });
    },
  };
  const { session } = await openSession(
    services,
    "ctx" as HostContext,
    "main",
    createApp({ events: {}, plugins: [plugin] }),
  );
  await session.receive({
    kind: "listen",
    protocol: helloMessage.protocol,
    id: "l1",
    event: "notes.changed",
  });
  await flush();
  await emit?.({ key: "from-backend" });
  await flush();
  expect(sent.filter(({ message }) => message.kind === "event")).toMatchObject([
    { message: { source: "backend", sequence: 1, payload: { key: "from-backend" } } },
  ]);
});

test("subscription queue overflow ends the subscription with BUSY", async () => {
  const clock = createClock();
  let open = true;
  const gate = deferred<void>();
  const sent: { context: HostContext; message: ServerMessage }[] = [];
  const send: Send = (context, message) => {
    sent.push({ context, message });
    return open ? Promise.resolve() : gate.promise;
  };
  const { services } = createServices(clock, { send });
  const { session } = await openSession(services, "ctx" as HostContext, "main");
  await session.receive({
    kind: "listen",
    protocol: helloMessage.protocol,
    id: "l1",
    event: "notes.changed",
  });
  await flush();
  open = false;
  const emit = (id: string) =>
    session.receive({
      kind: "invoke",
      protocol: helloMessage.protocol,
      id,
      command: "notes.emit",
      payload: "x",
    });
  for (let i = 0; i <= API_LIMITS.maxPending + 1; i++) await emit(`e-${i}`);
  await flush();
  open = true;
  gate.resolve();
  await flush(600);
  const errors = sent.filter(({ message }) => message.kind === "subscription-error");
  expect(errors).toMatchObject([{ message: { subscriptionId: "sub-1", error: { code: "BUSY" } } }]);
  const events = sent.filter(({ message }) => message.kind === "event");
  expect(events.length).toBeGreaterThan(0);
  expect(events.length).toBeLessThanOrEqual(API_LIMITS.maxPending);
  let lastEvent = -1;
  for (const [index, { message }] of sent.entries()) {
    if (message.kind === "event") lastEvent = index;
  }
  const terminal = sent.findIndex(({ message }) => message.kind === "subscription-error");
  expect(lastEvent).toBeLessThan(terminal);
});

test("reserved and duplicate names plus plugin violations fail creation", async () => {
  const clock = createClock();
  const { services } = createServices(clock);
  const reserved = createApp({
    commands: {
      "bunaway.capabilities": command({
        input: { const: null },
        output: { const: null },
        handle: () => null,
      }),
    },
  });
  await expect(createCore(reserved, services)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

  const duplicate: PluginDefinition = {
    name: "dup",
    version: "1",
    commands: {
      "notes.read": command({ input: {}, output: {}, handle: () => null }),
    },
  };
  await expect(createCore(createApp({ plugins: [duplicate] }), services)).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });

  const cycle: PluginDefinition[] = [
    { name: "a", version: "1", dependencies: ["b"] },
    { name: "b", version: "1", dependencies: ["a"] },
  ];
  await expect(createCore(createApp({ plugins: cycle }), services)).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });

  const missing: PluginDefinition = { name: "a", version: "1", dependencies: ["ghost"] };
  await expect(createCore(createApp({ plugins: [missing] }), services)).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });

  const wrongPlatform: PluginDefinition = { name: "mac", version: "1", platforms: ["macos"] };
  await expect(createCore(createApp({ plugins: [wrongPlatform] }), services)).rejects.toMatchObject(
    { code: "UNSUPPORTED" },
  );

  const needsHost: PluginDefinition = {
    name: "greedy",
    version: "1",
    requiredHost: {
      log: true,
      storage: [{ scope: "temp", pathPrefix: "", access: ["write"] }],
    },
  };
  await expect(createCore(createApp({ plugins: [needsHost] }), services)).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });

  const covered: PluginDefinition = {
    name: "covered",
    version: "1",
    requiredHost: {
      log: true,
      storage: [{ scope: "appData", pathPrefix: "deep/dir", access: ["read"] }],
    },
  };
  await expect(createCore(createApp({ plugins: [covered] }), services)).resolves.toBeDefined();
});

test("plugins initialize in dependency order and clean up in reverse", async () => {
  const clock = createClock();
  const { services, hostCalls } = createServices(clock);
  const order: string[] = [];
  const stops: string[] = [];
  const make = (name: string, dependencies?: string[]): PluginDefinition => ({
    name,
    version: "1",
    ...(dependencies ? { dependencies } : {}),
    async setup(context) {
      order.push(name);
      await context.host.call("log.write", { level: "info", message: name });
      return () => {
        stops.push(name);
      };
    },
  });
  const core = await createCore(
    createApp({ plugins: [make("c", ["b"]), make("a"), make("b", ["a"])] }),
    services,
  );
  expect(order).toEqual(["a", "b", "c"]);
  expect(hostCalls.map(({ context }) => context)).toEqual([
    "backend-context" as HostContext,
    "backend-context" as HostContext,
    "backend-context" as HostContext,
  ]);
  await core.stop();
  expect(stops).toEqual(["c", "b", "a"]);
});

test("a plugin setup failure runs earlier stop hooks and rejects creation", async () => {
  const clock = createClock();
  const { services } = createServices(clock);
  const stops: string[] = [];
  const plugins: PluginDefinition[] = [
    {
      name: "first",
      version: "1",
      setup: () => {
        stops.push("registered");
        return () => {
          stops.push("first");
        };
      },
    },
    {
      name: "broken",
      version: "1",
      dependencies: ["first"],
      setup: () => {
        throw new Error("private details");
      },
    },
  ];
  await expect(createCore(createApp({ plugins }), services)).rejects.toMatchObject({
    code: "INTERNAL",
    message: "Plugin setup failed.",
  });
  expect(stops).toEqual(["registered", "first"]);
});

test("the built-in capabilities command calls the host operation", async () => {
  const clock = createClock();
  const recorded: { context: HostContext; call: HostCall }[] = [];
  const { services, sent } = createServices(clock, {
    callHost: async (context, call) => {
      recorded.push({ context, call });
      return {
        kind: "result" as const,
        payload: [{ name: "storage", support: "supported", permission: "granted" }],
      };
    },
  });
  const hostCalls = recorded;
  const { session } = await openSession(services);
  await session.receive({
    kind: "invoke",
    protocol: helloMessage.protocol,
    id: "cap",
    command: "bunaway.capabilities",
    payload: null,
  });
  await flush();
  expect(hostCalls).toEqual([
    {
      context: "view-context-1" as HostContext,
      call: { operation: "capabilities.get", payload: null },
    },
  ]);
  expect(results(sent, "cap")).toEqual([
    {
      kind: "result",
      protocol: helloMessage.protocol,
      id: "cap",
      payload: [{ name: "storage", support: "supported", permission: "granted" }],
    },
  ]);
});

test("session close is idempotent, fails pending work and frees nothing early", async () => {
  const clock = createClock();
  const { services, sent } = createServices(clock);
  const { core, session } = await openSession(services);
  await session.receive({
    kind: "invoke",
    protocol: helloMessage.protocol,
    id: "r1",
    command: "notes.slow",
    payload: null,
  });
  const first = session.close();
  const second = session.close();
  await Promise.all([first, second]);
  expect(results(sent, "r1")).toMatchObject([{ kind: "error", error: { code: "CANCELLED" } }]);
  await session.receive({
    kind: "invoke",
    protocol: helloMessage.protocol,
    id: "r2",
    command: "notes.read",
    payload: { key: "a" },
  });
  await flush();
  expect(results(sent, "r2")).toEqual([]);
  const reopened = core.openSession("view-context-1" as HostContext, "main");
  expect(reopened).toBeDefined();
  await core.stop();
});

test("unknown views, duplicate contexts and stopped cores reject openSession", async () => {
  const clock = createClock();
  const { services } = createServices(clock);
  const core = await createCore(createApp(), services);
  expect(() => core.openSession("a" as HostContext, "ghost")).toThrow("Unknown view");
  core.openSession("dup" as HostContext, "main");
  expect(() => core.openSession("dup" as HostContext, "main")).toThrow("Duplicate context");
  await core.stop();
  expect(() => core.openSession("late" as HostContext, "main")).toThrow("Core is stopped.");
});

test("stop aborts backend work, closes sessions, and reports slow cleanup as TIMEOUT", async () => {
  const clock = createClock();
  const { services } = createServices(clock);
  let backendAborted = false;
  const plugin: PluginDefinition = {
    name: "worker",
    version: "1",
    setup(context) {
      context.signal.addEventListener("abort", () => {
        backendAborted = true;
      });
    },
  };
  const { core, session } = await openSession(
    services,
    "ctx" as HostContext,
    "main",
    createApp({ plugins: [plugin] }),
  );
  await session.receive({
    kind: "invoke",
    protocol: helloMessage.protocol,
    id: "r1",
    command: "notes.slow",
    payload: null,
  });
  await core.stop();
  expect(backendAborted).toBe(true);
  const second = createClock();
  const hanging: PluginDefinition = {
    name: "hanging",
    version: "1",
    setup: () => () => new Promise<void>(() => {}),
  };
  const slowCore = await createCore(
    createApp({ plugins: [hanging] }),
    createServices(second).services,
  );
  const stopped = slowCore.stop();
  second.advance(API_LIMITS.shutdownTimeoutMs);
  let failure: unknown;
  try {
    await stopped;
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toMatchObject({ code: "TIMEOUT" });
});

test("duplicate IDs preserve a pending request and never repeat its result", async () => {
  const clock = createClock();
  const { services, sent } = createServices(clock);
  const gate = deferred<null>();
  let runs = 0;
  const { core, session } = await openSession(
    services,
    "ctx" as HostContext,
    "main",
    createApp({
      commands: {
        "notes.slow": command({
          input: { const: null },
          output: { const: null },
          handle: () => {
            runs++;
            return gate.promise;
          },
        }),
      },
    }),
  );
  const request = {
    kind: "invoke" as const,
    protocol: helloMessage.protocol,
    id: "same",
    command: "notes.slow",
    payload: null,
  };
  await session.receive(request);
  await session.receive(request);
  await session.receive({
    kind: "listen",
    protocol: helloMessage.protocol,
    id: "same",
    event: "notes.changed",
  });
  await flush();
  expect(results(sent, "same")).toEqual([]);
  gate.resolve(null);
  await flush();
  await session.receive(request);
  expect(runs).toBe(1);
  expect(results(sent, "same")).toMatchObject([{ kind: "result", payload: null }]);
  await core.stop();
});

test("storage permissions combine grants without widening scope or path", async () => {
  const clock = createClock();
  const { services } = createServices(clock);
  const splitServices: CoreServices = {
    ...services,
    policy: {
      ...policy,
      backend: {
        log: true,
        storage: [
          { scope: "appData", pathPrefix: "", access: ["read"] },
          { scope: "appData", pathPrefix: "notes", access: ["write"] },
        ],
      },
    },
  };
  const app = (scope: "appData" | "temp", pathPrefix: string) =>
    createApp({
      plugins: [
        {
          name: "notes",
          version: "1",
          requiredHost: {
            log: false,
            storage: [{ scope, pathPrefix, access: ["read", "write"] }],
          },
        },
      ],
    });
  for (const path of ["notes", "notes/nested"]) {
    const core = await createCore(app("appData", path), splitServices);
    await core.stop();
  }
  for (const path of ["", "notes-private", "other"]) {
    await expect(createCore(app("appData", path), splitServices)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  await expect(createCore(app("temp", "notes"), splitServices)).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});

test("failed startup cancels backend Host calls before reverse cleanup", async () => {
  const clock = createClock();
  let hostSignal: Parameters<CoreServices["callHost"]>[2] | undefined;
  const { services } = createServices(clock, {
    callHost: async (_context, _call, signal) => {
      hostSignal = signal;
      return new Promise(() => {});
    },
  });
  let saved: Parameters<NonNullable<PluginDefinition["setup"]>>[0] | undefined;
  let pending: Promise<unknown> | undefined;
  const stops: string[] = [];
  await expect(
    createCore(
      createApp({
        plugins: [
          {
            name: "first",
            version: "1",
            setup: () => () => {
              stops.push("first");
            },
          },
          {
            name: "worker",
            version: "1",
            setup(context) {
              saved = context;
              pending = context.host
                .call("log.write", { level: "info", message: "pending" })
                .catch((error: unknown) => error);
              return () => {
                expect(context.signal.aborted).toBe(true);
                stops.push("worker");
              };
            },
          },
          {
            name: "broken",
            version: "1",
            setup() {
              throw new Error("private details");
            },
          },
        ],
      }),
      services,
    ),
  ).rejects.toMatchObject({ code: "INTERNAL", message: "Plugin setup failed." });
  expect(stops).toEqual(["worker", "first"]);
  expect(hostSignal?.aborted).toBe(true);
  expect(await pending).toMatchObject({ code: "CANCELLED" });
  if (!saved) throw new Error("Plugin context was not captured.");
  await expect(
    saved.host.call("log.write", { level: "info", message: "late" }),
  ).rejects.toMatchObject({ code: "CANCELLED" });
});

test("failed startup bounds plugin cleanup by the shutdown deadline", async () => {
  const clock = createClock();
  const { services } = createServices(clock);
  const creation = createCore(
    createApp({
      plugins: [
        { name: "worker", version: "1", setup: () => () => new Promise<void>(() => {}) },
        {
          name: "broken",
          version: "1",
          setup() {
            throw new Error("private details");
          },
        },
      ],
    }),
    services,
  );
  const failure = creation.catch((error: unknown) => error);
  await flush();
  clock.advance(API_LIMITS.shutdownTimeoutMs);
  expect(await failure).toMatchObject({ code: "TIMEOUT" });
});

for (const shutdown of ["close", "stop"] as const) {
  test(`queued subscription overflow error is discarded after ${shutdown}`, async () => {
    const clock = createClock();
    const gate = deferred<void>();
    const sent: ServerMessage[] = [];
    const { services } = createServices(clock, {
      send: async (_context, message) => {
        sent.push(message);
        if (message.kind === "result") await gate.promise;
      },
    });
    let emit!: () => Promise<void>;
    const { core, session } = await openSession(
      services,
      "ctx" as HostContext,
      "main",
      createApp({
        plugins: [
          {
            name: "emitter",
            version: "1",
            setup(context) {
              emit = () =>
                context.events.emit("notes.changed", { key: "x" }, { kind: "broadcast" });
            },
          },
        ],
      }),
    );
    await session.receive({
      kind: "listen",
      protocol: helloMessage.protocol,
      id: "l1",
      event: "notes.changed",
    });
    for (let i = 0; i <= API_LIMITS.maxPending; i++) await emit();
    if (shutdown === "close") await session.close();
    else await core.stop();
    expect(sent.map((message) => message.kind)).toEqual(["hello", "result"]);
    gate.resolve();
    await flush(600);
    expect(sent.map((message) => message.kind)).toEqual(["hello", "result"]);
    await core.stop();
  });
}

for (const shutdown of ["cancel", "timeout", "close"] as const) {
  test(`late command events cannot reach a new session after ${shutdown}`, async () => {
    const clock = createClock();
    const { services, sent } = createServices(clock);
    const gate = deferred<null>();
    let emissionFailure: unknown;
    const { core, session } = await openSession(
      services,
      "old" as HostContext,
      "main",
      createApp({
        commands: {
          "notes.slow": command({
            input: { const: null },
            output: { const: null },
            async handle(_input, context) {
              await gate.promise;
              try {
                await context.events.emit("notes.changed", { key: "stale" }, { kind: "broadcast" });
              } catch (cause) {
                emissionFailure = cause;
              }
              return null;
            },
          }),
        },
      }),
    );
    await session.receive({
      kind: "invoke",
      protocol: helloMessage.protocol,
      id: "slow",
      command: "notes.slow",
      payload: null,
    });
    if (shutdown === "cancel")
      await session.receive({ kind: "cancel", protocol: helloMessage.protocol, id: "slow" });
    else if (shutdown === "timeout") clock.advance(API_LIMITS.maxCommandDurationMs);
    else await session.close();

    const fresh = core.openSession("fresh" as HostContext, "main");
    await fresh.receive(helloMessage);
    await fresh.receive({
      kind: "listen",
      protocol: helloMessage.protocol,
      id: "listen",
      event: "notes.changed",
    });
    gate.resolve(null);
    await flush();
    expect(emissionFailure).toMatchObject({ code: "CANCELLED" });
    expect(sent.filter(({ message }) => message.kind === "event")).toEqual([]);
    expect(results(sent, "slow")).toMatchObject([
      { kind: "error", error: { code: shutdown === "timeout" ? "TIMEOUT" : "CANCELLED" } },
    ]);
    await core.stop();
  });
}
