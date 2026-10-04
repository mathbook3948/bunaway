import { expect, test } from "bun:test";
import {
  command,
  type AppDefinition,
  type CommandsOf,
  type EventsOf,
  type PluginDefinition,
} from "../../packages/backend-sdk/src/index.ts";
import type { Client, ClientFactory } from "../../packages/client-sdk/src/index.ts";
import type {
  CommandContext,
  CoreFactory,
  CoreServices,
  CoreSession,
  RuntimeServices,
} from "../../packages/core/src/index.ts";
import {
  BunawayError,
  type CancellationSignal,
  type ClientMessage,
  type HostContext,
  type HostResponse,
  type JsonValue,
  type Policy,
  type ServerMessage,
  type Transport,
  type TransportEvent,
  parseBootstrap,
  parseHostCall,
  parseMessage,
  parseProcessFrame,
  serializeHostCall,
  validateHostOutput,
  validateValue,
} from "../../packages/protocol/src/index.ts";
import { bindHostAPI } from "../../packages/runtime-bun/src/index.ts";

const input = {
  type: "object",
  properties: { key: { type: "string", maxLength: 32 } },
  required: ["key"],
  additionalProperties: false,
} as const;
const output = { type: "string" } as const;
const app = {
  commands: {
    "notes.read": command({
      input,
      output,
      handle: ({ key }, context) =>
        context.host.call("storage.readText", { scope: "appData", path: `notes/${key}.txt` }),
    }),
  },
  events: { "notes.changed": input },
} satisfies AppDefinition;

const policy: Policy = {
  version: 1,
  views: [
    {
      id: "main",
      origins: ["https://app.bunaway.local"],
      commands: ["notes.read", "bunaway.capabilities"],
      events: ["notes.changed"],
      host: { log: false, storage: [{ scope: "appData", pathPrefix: "notes", access: ["read"] }] },
    },
  ],
  backend: { log: false, storage: [] },
};
// The fixture stands in for the trusted native/runtime adapter, not a Web payload.
const contextId = "host-session-1" as HostContext;

function context(host: CommandContext["host"], signal: CancellationSignal): CommandContext {
  const state = new Map<string, JsonValue>();
  return {
    host,
    signal,
    state: {
      get: (key) => state.get(key),
      set: (key, value) => {
        state.set(key, value);
      },
      delete: (key) => state.delete(key),
    },
    events: { async emit() {} },
  };
}

test("a typed backend command validates input/output and preserves its bound Host context", async () => {
  const controller = new AbortController();
  const seen: unknown[] = [];
  const host = bindHostAPI(contextId, controller.signal, async (id, call, signal) => {
    seen.push({ id, call, signal });
    return { kind: "result", payload: "welcome" };
  });
  const ctx = context(host, controller.signal);
  expect(await app.commands["notes.read"].run({ key: "welcome" }, ctx)).toBe("welcome");
  expect(seen).toEqual([
    {
      id: contextId,
      call: {
        operation: "storage.readText",
        payload: { scope: "appData", path: "notes/welcome.txt" },
      },
      signal: controller.signal,
    },
  ]);
  await expect(app.commands["notes.read"].run({ key: 42 }, ctx)).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    message: "Invalid command input.",
  });
  await expect(
    app.commands["notes.read"].run({ key: "welcome", context: "backend" }, ctx),
  ).rejects.toThrow();
  expect(seen).toHaveLength(1);
  const bad = command({ input: { const: null }, output, handle: () => 42 as unknown as string });
  await expect(bad.run(null, ctx)).rejects.toMatchObject({
    code: "INTERNAL",
    message: "Invalid command output.",
  });
});

test("Host operations share exact request/result schemas and safe errors", async () => {
  expect(
    parseHostCall(
      serializeHostCall({
        operation: "storage.writeText",
        payload: { scope: "temp", path: "notes/new.txt", text: "한글" },
      }),
    ),
  ).toEqual({
    operation: "storage.writeText",
    payload: { scope: "temp", path: "notes/new.txt", text: "한글" },
  });
  for (const call of [
    { operation: "unknown", payload: null },
    { operation: "storage.readText", payload: { scope: "root", path: "notes/a" } },
    { operation: "storage.readText", payload: { scope: "appData", path: "a\0b" } },
    { operation: "storage.readText", payload: { scope: "appData", path: "a", context: "backend" } },
    { operation: "capabilities.get", payload: {} },
  ])
    expect(() => parseHostCall(JSON.stringify(call))).toThrow();
  expect(validateHostOutput("storage.writeText", null)).toBeNull();
  expect(() => validateHostOutput("storage.writeText", true)).toThrow();
  expect(
    validateHostOutput("capabilities.get", [
      { name: "storage", support: "supported", permission: "denied" },
    ]),
  ).toHaveLength(1);
  expect(() =>
    validateHostOutput("capabilities.get", [
      { name: "storage", support: "yes", permission: "denied" },
    ]),
  ).toThrow();
  expect(() =>
    validateHostOutput("capabilities.get", [
      { name: "storage", support: "supported", permission: "denied" },
      { name: "storage", support: "unsupported", permission: "unknown" },
    ]),
  ).toThrow();
  const signal = new AbortController().signal;
  const denied = bindHostAPI(contextId, signal, async () => ({
    kind: "error",
    error: { code: "PERMISSION_DENIED", message: "Access denied." },
  }));
  const raw = bindHostAPI(contextId, signal, async () => {
    throw new Error("private-native-path");
  });
  const invalid = bindHostAPI(contextId, signal, async () => ({ kind: "result", payload: 42 }));
  await expect(
    denied.call("storage.readText", { scope: "appData", path: "notes/a" }),
  ).rejects.toMatchObject({ code: "PERMISSION_DENIED", message: "Access denied." });
  await expect(raw.call("log.write", { level: "info", message: "safe" })).rejects.toMatchObject({
    code: "INTERNAL",
    message: "Host operation failed.",
  });
  await expect(
    invalid.call("storage.readText", { scope: "appData", path: "notes/a" }),
  ).rejects.toMatchObject({ code: "INTERNAL", message: "Invalid host response." });
  expect(new BunawayError({ code: "BUSY", message: "Queue full." })).toBeInstanceOf(Error);
});

test("cancelled Host calls cannot start or deliver a late successful result", async () => {
  const controller = new AbortController();
  let calls = 0;
  const host = bindHostAPI(contextId, controller.signal, async () => {
    calls++;
    return { kind: "result", payload: null };
  });
  controller.abort();
  await expect(
    host.call("log.write", { level: "info", message: "cancelled" }),
  ).rejects.toMatchObject({ code: "CANCELLED" });
  expect(calls).toBe(0);
  const lateController = new AbortController();
  const late = bindHostAPI(contextId, lateController.signal, async () => {
    lateController.abort();
    return { kind: "result", payload: "late" };
  });
  await expect(late.call("storage.readText", { scope: "temp", path: "a" })).rejects.toMatchObject({
    code: "CANCELLED",
  });
});

test("Host paths use relative forward-slash paths while native access checks remain required", () => {
  for (const path of [
    "",
    "/absolute",
    "C:/absolute",
    "C:relative-drive",
    "../escape",
    "notes/../escape",
    "notes/./a",
    "notes\\a",
  ]) {
    expect(() =>
      parseHostCall(
        JSON.stringify({ operation: "storage.readText", payload: { scope: "appData", path } }),
      ),
    ).toThrow();
  }
  const call = {
    operation: "storage.readText",
    payload: { scope: "appData", path: "notes/한글 파일.txt" },
  } as const;
  expect(parseHostCall(JSON.stringify(call))).toEqual(call);
});

test("host-only boot policy and session-open never enter the Web message bridge", () => {
  const boot = parseBootstrap(
    JSON.stringify({
      entrypoint: "C:/app/backend.js",
      buildId: "test",
      policy,
      backendContext: "native-backend-context",
    }),
  );
  expect(boot.policy).toEqual(policy);
  expect(boot.backendContext).toBe("native-backend-context");
  const frame = {
    ipc: { major: 1, minor: 0 },
    runtime: { id: "app", generation: "1" },
    kind: "session-open",
    context: "native-context",
    viewId: "main",
  } as const;
  expect(parseProcessFrame(JSON.stringify(frame))).toEqual(frame);
  expect(() => parseMessage(JSON.stringify(frame))).toThrow();
  const cancel = {
    ipc: frame.ipc,
    runtime: frame.runtime,
    kind: "host-cancel",
    context: "native-context",
    requestId: "host-request-1",
  } as const;
  expect(parseProcessFrame(JSON.stringify(cancel))).toEqual(cancel);
  expect(() => parseMessage(JSON.stringify(cancel))).toThrow();
});

test("pending Host calls abort promptly and release their cancellation listener", async () => {
  const controller = new AbortController();
  const listeners = new Set<() => void>();
  const signal: CancellationSignal = {
    get aborted() {
      return controller.signal.aborted;
    },
    addEventListener(type, listener) {
      listeners.add(listener);
      controller.signal.addEventListener(type, listener);
    },
    removeEventListener(type, listener) {
      listeners.delete(listener);
      controller.signal.removeEventListener(type, listener);
    },
  };
  let complete!: (response: HostResponse) => void;
  const pending = new Promise<HostResponse>((resolve) => {
    complete = resolve;
  });
  let started = false;
  const host = bindHostAPI(contextId, signal, () => {
    started = true;
    return pending;
  });
  const task = host.call("storage.readText", { scope: "temp", path: "notes/a" });
  await Promise.resolve();
  expect(started).toBe(true);
  expect(listeners.size).toBe(1);
  controller.abort();
  await expect(task).rejects.toMatchObject({ code: "CANCELLED" });
  expect(listeners.size).toBe(0);
  complete({ kind: "result", payload: "late" });
  await pending;
});

// Type assertions below are not executed by the runtime tests.
export function checkClientTypes(
  client: Client<CommandsOf<typeof app>, EventsOf<typeof app>>,
  factory: ClientFactory,
  transport: Transport,
) {
  const result: Promise<string> = client.invoke(
    "notes.read",
    { key: "welcome" },
    { signal: new AbortController().signal },
  );
  void result;
  client.listen(
    "notes.changed",
    (event) => {
      const key: string = event.payload.key;
      void key;
    },
    {
      onError: (error) => {
        const code: string = error.code;
        void code;
      },
    },
  );
  // @ts-expect-error unknown command
  client.invoke("notes.delete", { key: "welcome" });
  // @ts-expect-error wrong input type
  client.invoke("notes.read", { key: 42 });
  // @ts-expect-error wrong output type
  const incorrect: Promise<number> = client.invoke("notes.read", { key: "welcome" });
  void incorrect;
  // @ts-expect-error unknown event
  client.listen("notes.missing", () => {}, { onError() {} });
  // @ts-expect-error subscription failure must have an observer
  client.listen("notes.changed", () => {});
  const created = factory<CommandsOf<typeof app>, EventsOf<typeof app>>({
    transport,
    hello: { kind: "hello", protocol: { major: 1, minor: 0 }, features: [], buildId: "client" },
  });
  created.invoke("bunaway.capabilities", null);
  created.capabilities();
}

export function checkCoreTypes(
  factory: CoreFactory,
  services: CoreServices,
  session: CoreSession,
  clientMessage: ClientMessage,
  serverMessage: ServerMessage,
  runtime: RuntimeServices,
) {
  factory(app, services).then((core) => {
    core.openSession(contextId, "main").receive(clientMessage);
    core.stop();
  });
  session.receive(clientMessage);
  // @ts-expect-error server replies are not inbound client requests
  session.receive(serverMessage);
  services.callHost(
    // @ts-expect-error callers may not substitute an unbranded Web-supplied context ID
    "from-web",
    { operation: "capabilities.get", payload: null },
    new AbortController().signal,
  );
  const plugin = {
    name: "storage",
    version: "0.0.0",
    platforms: ["windows"],
    commands: app.commands,
    events: app.events,
    setup(ctx) {
      ctx.state.set("ready", true);
      return async () => {
        ctx.state.delete("ready");
      };
    },
  } satisfies PluginDefinition;
  void plugin;
  const stop = runtime.schedule(() => {}, 100);
  stop();
  services.callHost(
    contextId,
    // @ts-expect-error storage writes require text
    { operation: "storage.writeText", payload: { scope: "temp", path: "a" } },
    new AbortController().signal,
  );
}

export function checkTransportTypes(transport: Transport) {
  const off = transport.subscribe((event: TransportEvent) => {
    if (event.kind === "message") parseMessage(event.text);
  });
  off();
  transport.close();
  // @ts-expect-error transport carries serialized JSON, not authority-bearing objects
  transport.send({ context: "backend" });
  // @ts-expect-error host results are separate from Web results
  const response: HostResponse = { kind: "result", payload: null, id: "web-request" };
  void response;
  validateValue({ const: null }, null);
}
