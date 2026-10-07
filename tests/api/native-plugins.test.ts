import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { bindHostAPI, type CoreServices, createCore } from "../../packages/core/src/index.ts";
import { defineNativePlugin, s } from "../../packages/plugin-sdk/src/index.ts";
import {
  type HostContext,
  NativeRegistry,
  type Policy,
  type ServerMessage,
} from "../../packages/protocol/src/index.ts";
import { storagePlugin } from "../../plugins/storage/src/index.ts";
import { contracts } from "../fixtures/host-plugins.ts";

const readText = contracts["storage.readText"];
const writeText = contracts["storage.writeText"];
const matches = storagePlugin.matches;

test("short declarations generate strict schemas, qualified names and shared permissions", () => {
  const input = s.object({
    level: s.enum(["info", "error"]),
    message: s.string({ maxLength: 4 }),
    details: s.optional(s.json()),
    nested: s.object({
      count: s.integer({ minimum: 0 }),
      enabled: s.boolean(),
      names: s.array(s.string(), { maxItems: 1 }),
    }),
  });
  const operation = { input, output: s.null(), permission: "record" };
  const plugin = defineNativePlugin({
    name: "audit",
    version: "1",
    operations: { write: operation, repeat: operation },
    scopes: { record: s.object({ prefix: s.string() }) },
    matches: () => true,
  });
  const registry = new NativeRegistry([plugin.definition]);
  const payload: Parameters<typeof plugin.api.write>[0] = {
    level: "info",
    message: "ok",
    nested: { count: 0, enabled: true, names: ["a"] },
  };
  expect(Object.keys(plugin.api)).toEqual(["write", "repeat"]);
  expect([...registry.operations.keys()]).toEqual(["audit.write", "audit.repeat"]);
  expect([...registry.permissions.keys()]).toEqual(["audit:record"]);
  expect(registry.validateCall({ operation: "audit.write", payload }).payload).toEqual(payload);
  expect(
    registry.validateCall({
      operation: "audit.write",
      payload: { ...payload, details: { tags: [null, true] } },
    }).payload,
  ).toHaveProperty("details");
  for (const invalid of [
    { message: "ok", nested: payload.nested },
    { ...payload, level: "debug" },
    { ...payload, message: "too long" },
    { ...payload, extra: true },
    { ...payload, nested: { ...payload.nested, count: -1 } },
    { ...payload, nested: { ...payload.nested, enabled: "yes" } },
    { ...payload, nested: { ...payload.nested, names: ["a", "b"] } },
  ])
    expect(() => registry.validateCall({ operation: "audit.write", payload: invalid })).toThrow();
  expect(registry.validateOutput("audit.write", null)).toBeNull();
  expect(() => registry.validateOutput("audit.write", false)).toThrow();
  expect(
    defineNativePlugin({
      name: "audit",
      version: "1",
      operations: { write: { ...operation, permission: "toString" } },
      scopes: {},
    }).definition.native.permissions,
  ).toEqual([{ name: "audit:toString" }]);
  expect(() =>
    defineNativePlugin({
      name: "audit",
      version: "1",
      operations: { write: operation },
      scopes: { unused: s.string() },
    }),
  ).toThrow("unused permission");
  expect(() =>
    defineNativePlugin({
      name: "audit",
      version: "1",
      operations: { write: operation },
      scopes: { record: s.string() },
    }),
  ).toThrow("require matches");
});

export function checkShortDeclarationTypes() {
  const plugin = defineNativePlugin({
    name: "example",
    version: "1",
    operations: {
      write: {
        input: s.object({
          level: s.enum(["info", "error"]),
          message: s.string(),
          details: s.optional(s.json()),
        }),
        output: s.null(),
        permission: "write",
      },
    },
  });
  const result: Promise<null> = plugin.api.write({ level: "info", message: "ok" });
  void result;
  // @ts-expect-error required fields remain required
  plugin.api.write({ level: "info" });
  // @ts-expect-error enum literals remain restricted
  plugin.api.write({ level: "debug", message: "ok" });
  // @ts-expect-error optional fields must still be JSON
  plugin.api.write({ level: "info", message: "ok", details: () => {} });
  const numeric = defineNativePlugin({
    name: "numbered",
    version: "1",
    operations: { 0: { input: s.object({ 0: s.string() }), output: s.null(), permission: "call" } },
  });
  void numeric.api[0]({ 0: "ok" });
  // @ts-expect-error numeric object keys are required too
  numeric.api[0]({});
}

const empty: Policy = { version: 1, views: [], backend: { permissions: [] } };
function services(policy = empty): CoreServices {
  return {
    policy,
    platform: "windows",
    backendContext: "backend" as HostContext,
    hello: { kind: "hello", protocol: { major: 1, minor: 0 }, features: [], buildId: "plugins" },
    runtime: {
      createCancellation: () => new AbortController(),
      now: Date.now,
      schedule: (run, delay) => {
        const timer = setTimeout(run, delay);
        return () => clearTimeout(timer);
      },
    },
    async send() {},
    async callHost() {
      return { kind: "result", payload: "saved" };
    },
  };
}

test("an app without native plugins has no host operations or implicit permissions", async () => {
  const registry = new NativeRegistry([]);
  expect(registry.operations.size).toBe(0);
  const core = await createCore({ commands: {}, events: {} }, services());
  await core.stop();
  await expect(
    bindHostAPI(
      "backend" as HostContext,
      new AbortController().signal,
      services().callHost,
      registry,
    ).call(readText, { scope: "temp", path: "a.txt" }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(() =>
    registry.validatePolicy({ ...empty, backend: { permissions: ["storage:read-text"] } }),
  ).toThrow();
});

test("canonical contracts reject caller schema and permission overrides and copy registration", async () => {
  const plugin = { ...storagePlugin, native: structuredClone(storagePlugin.native) };
  const registry = new NativeRegistry([plugin]);
  const copied = plugin.native.operations[0];
  if (!copied) throw new Error("Missing copied operation.");
  (copied.input as { required: readonly string[] }).required = [];
  const api = bindHostAPI(
    "backend" as HostContext,
    new AbortController().signal,
    services().callHost,
    registry,
  );
  await expect(
    api.call({ ...readText, input: {}, permission: "log:write" }, null),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(await api.call(readText, { scope: "temp", path: "a.txt" })).toBe("saved");
  expect(
    () =>
      new NativeRegistry([
        {
          ...storagePlugin,
          native: {
            ...storagePlugin.native,
            operations: [{ ...readText, input: { $ref: "ignored" } as never }],
          },
        },
      ]),
  ).toThrow();
});

test("scoped permissions aggregate allows, deny wins, and invalid scopes fail startup", () => {
  const registry = new NativeRegistry([storagePlugin]);
  const policy: Policy = {
    ...empty,
    backend: {
      permissions: [
        { identifier: writeText.permission, allow: [{ scope: "appData", pathPrefix: "notes" }] },
        {
          identifier: writeText.permission,
          allow: [{ scope: "temp", pathPrefix: "notes" }],
          deny: [{ scope: "appData", pathPrefix: "notes/private" }],
        },
      ],
    },
  };
  registry.validatePolicy(policy);
  const allowed = (scope: string, path: string) =>
    registry.allowed(
      policy.backend,
      { operation: writeText.name, payload: { scope, path, text: "saved" } },
      matches,
    );
  expect(allowed("appData", "notes/a.txt")).toBe(true);
  expect(allowed("temp", "notes/a.txt")).toBe(true);
  expect(allowed("appData", "notes/private/a.txt")).toBe(false);
  expect(allowed("appData", "notes-other/a.txt")).toBe(false);
  for (const permissions of [
    [writeText.permission],
    [{ identifier: writeText.permission, allow: [{ scope: "appData", pathPrefix: "../escape" }] }],
    [{ identifier: writeText.permission, allow: [{ scope: "root", pathPrefix: "" }] }],
  ])
    expect(() => registry.validatePolicy({ ...empty, backend: { permissions } })).toThrow();
});

test("native bridges require view command permission and distinguish missing plugins", async () => {
  const replies: ServerMessage[] = [];
  const policy: Policy = {
    ...empty,
    views: [
      {
        id: "main",
        origins: ["https://app.bunaway.local"],
        commands: ["plugin.storage.readText"],
        events: [],
        host: { permissions: [] },
      },
    ],
  };
  const adapter: CoreServices = {
    ...services(policy),
    send: async (_context, reply) => {
      replies.push(reply);
    },
  };
  const core = await createCore({ commands: {}, events: {} }, adapter);
  const session = core.openSession("view" as HostContext, "main");
  await session.receive(adapter.hello);
  for (const [id, command] of [
    ["missing", "plugin.storage.readText"],
    ["denied", "plugin.log.write"],
  ])
    await session.receive({
      kind: "invoke",
      protocol: adapter.hello.protocol,
      id: id ?? "",
      command: command ?? "",
      payload: null,
    });
  expect(replies).toContainEqual(
    expect.objectContaining({
      id: "missing",
      error: expect.objectContaining({ code: "UNSUPPORTED" }),
    }),
  );
  expect(replies).toContainEqual(
    expect.objectContaining({
      id: "denied",
      error: expect.objectContaining({ code: "PERMISSION_DENIED" }),
    }),
  );
  await core.stop();
});

test("unified plugin imports select browser and Bun implementations without leaking native code", async () => {
  for (const plugin of ["storage", "log", "capabilities"]) {
    for (const target of ["browser", "bun"] as const) {
      const result = await Bun.build({
        entrypoints: ["unified-plugin-entry"],
        target,
        metafile: true,
        plugins: [
          {
            name: "unified-plugin-test",
            setup(build) {
              build.onResolve({ filter: /^unified-plugin-entry$/ }, () => ({
                path: resolve(import.meta.dir, "../fixtures/desktop/host/unified-plugin.ts"),
                namespace: "file",
              }));
              build.onLoad({ filter: /unified-plugin\.ts$/ }, () => ({
                contents: `export * from "@bunaway/plugin-${plugin}";`,
                loader: "ts",
                resolveDir: resolve(import.meta.dir, "../fixtures/desktop/host"),
              }));
            },
          },
        ],
      });
      expect(result.success).toBe(true);
      const output = result.outputs[0];
      if (!output || !result.metafile) throw new Error("Missing plugin bundle.");
      const source = await output.text();
      const inputs = Object.keys(result.metafile.inputs);
      expect(inputs.some((name) => name.endsWith(`plugins/${plugin}/src/index.ts`))).toBe(true);
      expect(inputs.some((name) => /\/windows(?:\/|\.ts$)/.test(name))).toBe(false);
      expect(
        inputs.some((name) =>
          name.endsWith(`plugin-sdk/src/${target === "browser" ? "browser" : "bun"}.ts`),
        ),
      ).toBe(true);
      if (target === "browser") {
        for (const name of ["AsyncLocalStorage", "node:async_hooks", "bun:ffi", "kernel32.dll"])
          expect(source).not.toContain(name);
        expect(inputs.some((name) => /backend-sdk/.test(name))).toBe(false);
      } else expect(inputs.some((name) => /client-sdk/.test(name))).toBe(false);
    }
  }
});
