import { expect, test } from "bun:test";
import {
  type AppDefinition,
  type CommandContext,
  type CommandDefinition,
  command,
  defineApp,
  defineModule,
  type PluginDefinition,
} from "../../packages/backend-sdk/src/index.ts";
import { createClient } from "../../packages/client-sdk/src/index.ts";
import type { CoreServices } from "../../packages/core/src/index.ts";
import {
  type ClientMessage,
  type HostCall,
  type HostContext,
  type HostResponse,
  type JsonValue,
  type Policy,
  parseMessage,
  type TransportEvent,
} from "../../packages/protocol/src/index.ts";
import { capabilities } from "../../plugins/capabilities/src/index.ts";
import { log } from "../../plugins/log/src/index.ts";
import { storage } from "../../plugins/storage/src/index.ts";
import { allowedHost, bindHostAPI, contracts, createCore } from "../fixtures/host-plugins.ts";

const location = { scope: "appData", path: "notes/memo.txt" } as const;
const nullContract = { input: { const: null }, output: { const: null } } as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function context(
  name: string,
  callHost: CoreServices["callHost"],
  controller = new AbortController(),
): CommandContext {
  return {
    host: bindHostAPI(name as HostContext, controller.signal, callHost),
    signal: controller.signal,
    state: { get: () => undefined, set() {}, delete: () => false },
    events: { async emit() {} },
  };
}

test("Host helpers reject outside an execution context without synchronous throws", async () => {
  for (const call of [
    () => storage.readText(location),
    () => storage.writeText({ ...location, text: "memo" }),
    () => log.write({ level: "info", message: "message" }),
    () => log.debug("message"),
    () => log.info("message"),
    () => log.warn("message"),
    () => log.error("message"),
    () => capabilities(),
  ]) {
    await expect(call()).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  }
});

test("Host helpers keep the existing typed operation inputs, outputs and explicit API", async () => {
  const calls: HostCall[] = [];
  const ctx = context("main", async (_context, call) => {
    calls.push(call);
    return {
      kind: "result",
      payload:
        call.operation === "storage.readText"
          ? "saved"
          : call.operation === "capabilities.get"
            ? [{ name: "storage.readText", support: "supported", permission: "not-required" }]
            : null,
    };
  });
  const definition = command({
    ...nullContract,
    async handle(_input, current) {
      expect(await storage.readText(location)).toBe("saved");
      expect(await storage.writeText({ ...location, text: "memo" })).toBeNull();
      await log.write({ level: "debug", message: "write", details: null });
      await log.debug("debug");
      await log.info("info", { length: 4 });
      await log.warn("warn", [1, true]);
      await log.error("error", null);
      expect(await capabilities()).toEqual([
        { name: "storage.readText", support: "supported", permission: "not-required" },
      ]);
      expect(await current.host.call(contracts["storage.readText"], location)).toBe("saved");
      return null;
    },
  });
  await definition.run(null, ctx);
  expect(calls).toEqual([
    { operation: "storage.readText", payload: location },
    { operation: "storage.writeText", payload: { ...location, text: "memo" } },
    { operation: "log.write", payload: { level: "debug", message: "write", details: null } },
    { operation: "log.write", payload: { level: "debug", message: "debug" } },
    { operation: "log.write", payload: { level: "info", message: "info", details: { length: 4 } } },
    { operation: "log.write", payload: { level: "warn", message: "warn", details: [1, true] } },
    { operation: "log.write", payload: { level: "error", message: "error", details: null } },
    { operation: "capabilities.get", payload: null },
    { operation: "storage.readText", payload: location },
  ]);
});

test("concurrent module services preserve view policy after await and never use backend grants", async () => {
  const enter = deferred<void>();
  const release = deferred<void>();
  let entered = 0;
  async function save(text: string) {
    if (++entered === 2) enter.resolve();
    await release.promise;
    return storage.writeText({ ...location, text });
  }
  const notes = defineModule("notes").command(
    "save",
    { input: { type: "string" }, output: { const: null } },
    save,
  );
  const app = defineApp({ modules: [notes] });
  const granted: Policy["backend"] = {
    permissions: [
      "log:write",
      { identifier: "storage:read-text", allow: [{ scope: "appData", pathPrefix: "notes" }] },
      { identifier: "storage:write-text", allow: [{ scope: "appData", pathPrefix: "notes" }] },
    ],
  };
  const denied = { permissions: [] };
  const listeners = new Map<string, (event: TransportEvent) => void>();
  const attempts: { context: HostContext; call: HostCall }[] = [];
  const services: CoreServices = {
    platform: "windows",
    backendContext: "backend" as HostContext,
    hello: { kind: "hello", protocol: { major: 1, minor: 0 }, features: [], buildId: "host-sdk" },
    policy: {
      version: 1,
      backend: granted,
      views: ["granted", "denied"].map((id) => ({
        id,
        origins: ["https://app.bunaway.local"],
        commands: ["notes.save"],
        events: [],
        host: id === "granted" ? granted : denied,
      })),
    },
    runtime: {
      createCancellation: () => new AbortController(),
      now: () => performance.now(),
      schedule(callback, delay) {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    async send(id, message) {
      listeners.get(id)?.({ kind: "message", text: JSON.stringify(message) });
    },
    async callHost(id, call) {
      attempts.push({ context: id, call });
      return allowedHost(id === "granted" ? granted : denied, call)
        ? { kind: "result", payload: null }
        : { kind: "error", error: { code: "PERMISSION_DENIED", message: "Denied by view." } };
    },
  };
  const core = await createCore(app, services);
  function client(view: string) {
    const session = core.openSession(view as HostContext, view);
    return createClient({
      hello: services.hello,
      transport: {
        send: (text) => session.receive(parseMessage(text) as ClientMessage),
        subscribe(listener) {
          listeners.set(view, listener);
          return () => listeners.delete(view);
        },
        close: () => session.close(),
      },
    });
  }
  const first = client("granted");
  const second = client("denied");
  try {
    await Promise.all([first.ready, second.ready]);
    const saved = first.invoke("notes.save", "allowed");
    const refused = second.invoke("notes.save", "refused");
    const refusedError = refused.catch((error) => error);
    await enter.promise;
    release.resolve();
    expect(await saved).toBeNull();
    expect(await refusedError).toMatchObject({ code: "PERMISSION_DENIED" });
    expect(attempts.map(({ context }) => String(context)).sort()).toEqual(["denied", "granted"]);
  } finally {
    release.resolve();
    await Promise.all([first.close(), second.close()]);
    await core.stop();
  }
});

test("cancelling one concurrent command does not cancel or redirect another", async () => {
  const release = deferred<void>();
  const controller = new AbortController();
  const calls: string[] = [];
  const callHost: CoreServices["callHost"] = async (id) => {
    calls.push(id);
    return { kind: "result", payload: "memo" };
  };
  const read = command({
    input: { const: null },
    output: { type: "string" },
    async handle() {
      await release.promise;
      return storage.readText(location);
    },
  });
  const first = read.run(null, context("first", callHost, controller));
  const firstError = first.catch((error) => error);
  const second = read.run(null, context("second", callHost));
  controller.abort();
  release.resolve();
  expect(await firstError).toMatchObject({ code: "CANCELLED" });
  expect(await second).toBe("memo");
  expect(calls).toEqual(["second"]);
});

test("an awaited timer retains the command's Host context", async () => {
  const calls: string[] = [];
  const definition = command({
    input: { const: null },
    output: { type: "string" },
    handle() {
      return new Promise<string>((resolve) => {
        setTimeout(() => resolve(storage.readText(location)), 0);
      });
    },
  });
  expect(
    await definition.run(
      null,
      context("timer", async (id) => {
        calls.push(id);
        return { kind: "result", payload: "memo" };
      }),
    ),
  ).toBe("memo");
  expect(calls).toEqual(["timer"]);
});

test("cancellation interrupts an in-flight helper and discards a late Host response", async () => {
  const reached = deferred<void>();
  const response = deferred<HostResponse>();
  const controller = new AbortController();
  const definition = command({
    input: { const: null },
    output: { type: "string" },
    handle: () => storage.readText(location),
  });
  const pending = definition.run(
    null,
    context(
      "pending",
      async () => {
        reached.resolve();
        return response.promise;
      },
      controller,
    ),
  );
  const pendingError = pending.catch((error) => error);
  await reached.promise;
  controller.abort();
  expect(await pendingError).toMatchObject({ code: "CANCELLED" });
  response.resolve({ kind: "result", payload: "late" });
});

for (const failed of [false, true]) {
  test(`detached command work rejects after ${failed ? "failure" : "completion"}`, async () => {
    const release = deferred<void>();
    let later!: Promise<string>;
    let calls = 0;
    const definition = command({
      ...nullContract,
      handle() {
        later = (async () => {
          await release.promise;
          return storage.readText(location);
        })();
        if (failed) throw new Error("Failed handler");
        return null;
      },
    });
    const result = definition.run(
      null,
      context("ended", async () => {
        calls++;
        return { kind: "result", payload: "unexpected" };
      }),
    );
    if (failed) await expect(result).rejects.toThrow("Failed handler");
    else await result;
    const laterError = later.catch((error) => error);
    release.resolve();
    expect(await laterError).toMatchObject({ code: "CANCELLED" });
    expect(calls).toBe(0);
    await expect(storage.readText(location)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
}

test("nested command execution restores the outer caller after success or failure", async () => {
  const calls: string[] = [];
  const callHost: CoreServices["callHost"] = async (id) => {
    calls.push(id);
    return { kind: "result", payload: null };
  };
  const inner = command({
    ...nullContract,
    async handle() {
      await log.info("inner");
      throw new Error("inner failed");
    },
  });
  const outer = command({
    ...nullContract,
    async handle() {
      await log.info("before");
      await expect(inner.run(null, context("inner", callHost))).rejects.toThrow("inner failed");
      await log.info("after");
      return null;
    },
  });
  await outer.run(null, context("outer", callHost));
  expect(calls).toEqual(["outer", "inner", "outer"]);
});

test("defineApp binds raw app, module and plugin command definitions without mutating them", async () => {
  const raw = {
    ...nullContract,
    async run() {
      return storage.writeText({ ...location, text: "raw" });
    },
  };
  const plugin = { name: "raw", version: "1", commands: { "raw.write": raw } };
  const app = defineApp({
    modules: [{ name: "module", commands: { "module.raw": raw }, events: {} }],
    commands: { "app.raw": raw },
    plugins: [plugin],
  });
  const ctx = context("raw", async () => ({ kind: "result", payload: null }));
  expect(plugin.commands["raw.write"]).toBe(raw);
  for (const definition of [
    app.commands["app.raw"],
    app.commands["module.raw"],
    app.plugins?.[0]?.commands?.["raw.write"],
  ]) {
    expect(await definition?.run(null, ctx)).toBeNull();
  }
  await expect(raw.run()).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});

test("defineApp preserves class getter contracts and original method receivers", async () => {
  class GetterCommand implements CommandDefinition {
    #contract = nullContract;
    get input() {
      return this.#contract.input;
    }
    get output() {
      return this.#contract.output;
    }
    async run() {
      return storage.writeText({ ...location, text: "getter" });
    }
  }
  const raw = new GetterCommand();
  const setupOrder: string[] = [];
  class GetterPlugin implements PluginDefinition {
    #name = "getter";
    get name() {
      return this.#name;
    }
    get version() {
      return "1";
    }
    get dependencies() {
      return ["dependency"] as const;
    }
    get platforms() {
      return ["windows"] as const;
    }
    get requiredPermissions() {
      return ["log:write"] as const;
    }
    get commands() {
      return { "getter.write": raw };
    }
    get events() {
      return { "getter.changed": { const: null } as const };
    }
    async setup() {
      setupOrder.push(this.#name);
      await log.info(this.#name);
    }
  }
  const plugin = new GetterPlugin();
  const app = defineApp({
    modules: [{ name: "module", commands: { "module.getter": raw }, events: {} }],
    commands: { "app.getter": raw },
    plugins: [
      plugin,
      {
        name: "dependency",
        version: "1",
        setup() {
          setupOrder.push("dependency");
        },
      },
    ],
  });
  const bound = app.plugins?.[0];
  expect(bound).toMatchObject({
    name: "getter",
    version: "1",
    dependencies: ["dependency"],
    platforms: ["windows"],
    requiredPermissions: ["log:write"],
    events: { "getter.changed": { const: null } },
  });
  const ctx = context("getter", async () => ({ kind: "result", payload: null }));
  for (const definition of [
    app.commands["app.getter"],
    app.commands["module.getter"],
    bound?.commands?.["getter.write"],
  ]) {
    expect(definition?.input).toEqual(nullContract.input);
    expect(definition?.output).toEqual(nullContract.output);
    expect(await definition?.run(null, ctx)).toBeNull();
  }
  expect(plugin.commands["getter.write"]).toBe(raw);
  const services: CoreServices = {
    platform: "windows",
    backendContext: "backend" as HostContext,
    policy: { version: 1, views: [], backend: { permissions: [] } },
    hello: { kind: "hello", protocol: { major: 1, minor: 0 }, features: [], buildId: "getters" },
    runtime: {
      createCancellation: () => new AbortController(),
      now: () => performance.now(),
      schedule(callback, delay) {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    async send() {},
    async callHost() {
      return { kind: "result", payload: null };
    },
  };
  await expect(createCore(app, { ...services, platform: "macos" })).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  await expect(createCore(app, services)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(setupOrder).toEqual([]);
  const core = await createCore(app, {
    ...services,
    policy: { ...services.policy, backend: { permissions: ["log:write"] } },
  });
  try {
    expect(setupOrder).toEqual(["dependency", "getter"]);
  } finally {
    await core.stop();
  }
});

test("plugin setup descendants keep their own backend until shutdown, including simultaneous apps", async () => {
  const release = deferred<void>();
  const jobs: Promise<string>[] = [];
  const stopErrors: string[] = [];
  const calls: string[] = [];
  const plugin: PluginDefinition = {
    name: "setup",
    version: "1",
    async setup() {
      await log.info("setup");
      jobs.push(
        (async () => {
          await release.promise;
          return storage.readText(location);
        })(),
      );
      return async () => {
        try {
          await log.info("stopped");
        } catch (error) {
          stopErrors.push((error as { code: string }).code);
        }
      };
    },
  };
  const app = defineApp({ modules: [], plugins: [plugin] });
  async function start(id: string) {
    const services: CoreServices = {
      policy: {
        version: 1,
        views: [],
        backend: {
          permissions: [
            "log:write",
            { identifier: "storage:read-text", allow: [{ scope: "appData", pathPrefix: "notes" }] },
          ],
        },
      },
      hello: { kind: "hello", protocol: { major: 1, minor: 0 }, features: [], buildId: "setup" },
      platform: "windows",
      backendContext: id as HostContext,
      runtime: {
        createCancellation: () => new AbortController(),
        now: () => performance.now(),
        schedule(callback, delay) {
          const timer = setTimeout(callback, delay);
          return () => clearTimeout(timer);
        },
      },
      async send() {},
      async callHost(context, call) {
        expect(allowedHost(services.policy.backend, call)).toBe(true);
        calls.push(context);
        return { kind: "result", payload: call.operation === "storage.readText" ? context : null };
      },
    };
    return createCore(app, services);
  }
  const first = await start("backend-first");
  const second = await start("backend-second");
  try {
    await first.stop();
    const firstError = jobs[0]?.catch((error) => error);
    release.resolve();
    expect(await firstError).toMatchObject({ code: "CANCELLED" });
    expect(await jobs[1]).toBe("backend-second");
    expect(calls).toEqual(["backend-first", "backend-second", "backend-second"]);
    expect(stopErrors).toEqual(["CANCELLED"]);
    await expect(log.info("outside setup")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  } finally {
    release.resolve();
    await first.stop();
    await second.stop();
  }
  expect(stopErrors).toEqual(["CANCELLED", "CANCELLED"]);
});

test("Host helpers preserve path and message validation, Host errors and output validation", async () => {
  let calls = 0;
  const ctx = context("validation", async (_id, call) => {
    calls++;
    if (call.operation === "log.write")
      return { kind: "error", error: { code: "PERMISSION_DENIED", message: "No logging" } };
    return { kind: "result", payload: 42 };
  });
  await command({
    ...nullContract,
    async handle() {
      await expect(storage.readText({ ...location, path: "../escape" })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      await expect(log.info("x".repeat(1025))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(calls).toBe(0);
      await expect(log.info("denied")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await expect(storage.readText(location)).rejects.toMatchObject({ code: "INTERNAL" });
      return null;
    },
  }).run(null, ctx);
  expect(calls).toBe(2);
});

// Compile-time checks cover consumer signatures, without executing Host calls.
export function checkHostTypes() {
  const text: Promise<string> = storage.readText(location);
  const written: Promise<null> = storage.writeText({ ...location, text: "memo" });
  const logged: Promise<null> = log.info("info", { count: 1 });
  const support: Promise<JsonValue> = capabilities();
  void [text, written, logged, support];
  // @ts-expect-error storage scopes are restricted
  storage.readText({ scope: "home", path: "memo.txt" });
  // @ts-expect-error writes need text
  storage.writeText(location);
  // @ts-expect-error log details must be JSON
  log.info("info", () => {});
  // @ts-expect-error log levels are restricted
  log.write({ level: "trace", message: "message" });
  // @ts-expect-error storage reads return text
  const wrong: Promise<number> = storage.readText(location);
  void wrong;
  const app: AppDefinition = defineApp({ modules: [] });
  void app;
}

test("window helpers preserve the command context and typed operation payloads", async () => {
  const { windows } = await import("../../packages/backend-sdk/src/index.ts");
  await expect(windows.list()).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  const calls: HostCall[] = [];
  const ctx = context("editor", async (source, call) => {
    expect(source).toBe("editor" as HostContext);
    calls.push(call);
    return {
      kind: "result",
      payload:
        call.operation === "windows.list"
          ? [{ view: "editor", open: false }]
          : call.operation === "windows.close"
            ? false
            : null,
    };
  });
  await command({
    ...nullContract,
    async handle() {
      expect(await windows.list()).toEqual([{ view: "editor", open: false }]);
      await windows.create({ view: "editor" });
      await windows.recreate({ view: "editor" });
      await windows.show({ view: "editor" });
      await windows.hide({ view: "editor" });
      await windows.focus({ view: "editor" });
      await windows.setSize({ view: "editor", width: 900, height: 700 });
      await windows.setPosition({ view: "editor", x: -100, y: 20 });
      await windows.setFullscreen({ view: "editor", fullscreen: true });
      await windows.setCloseConfirmation({ view: "editor", message: "Close?" });
      await windows.setCloseConfirmation({ view: "editor", message: null });
      expect(await windows.close({ view: "editor" })).toBe(false);
      return null;
    },
  }).run(null, ctx);
  expect(calls.map((call) => call.operation)).toEqual([
    "windows.list",
    "windows.create",
    "windows.recreate",
    "windows.show",
    "windows.hide",
    "windows.focus",
    "windows.setSize",
    "windows.setPosition",
    "windows.setFullscreen",
    "windows.setCloseConfirmation",
    "windows.setCloseConfirmation",
    "windows.close",
  ]);
  expect(calls.map((call) => call.payload)).toEqual([
    null,
    { view: "editor" },
    { view: "editor" },
    { view: "editor" },
    { view: "editor" },
    { view: "editor" },
    { view: "editor", width: 900, height: 700 },
    { view: "editor", x: -100, y: 20 },
    { view: "editor", fullscreen: true },
    { view: "editor", message: "Close?" },
    { view: "editor", message: null },
    { view: "editor" },
  ]);
});
