import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { bindHostAPI, type CoreServices, createCore } from "@bunaway/core";
import { defineNativePlugin } from "@bunaway/plugin";
import { PLATFORMS } from "@bunaway/plugin-api";
import { storagePlugin } from "@bunaway/plugin-storage";
import {
  type HostContext,
  MAX_MESSAGE_BYTES,
  NativeRegistry,
  type Policy,
  parsePolicy,
  type ServerMessage,
  serializeHostResponse,
  serializeMessage,
} from "@bunaway/protocol";
import { z } from "zod";
import { hostResponse } from "#native/host-api/bun/host-response";
import { validatePacket } from "#native/windows/bun/channel";
import { contracts } from "../fixtures/host-plugins.ts";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const readText = contracts["storage.readText"];
const writeText = contracts["storage.writeText"];

test.each([
  ...PLATFORMS,
])("SDK accepts the %s platform declaration", (platform) => {
  const create = () => ({
    execute: () => null,
    dispose() {},
  });
  const plugin = defineNativePlugin({
    name: "demo",
    operations: {
      read: {
        input: z.null(),
        output: z.null(),
      },
    },
    platforms: {
      [platform]: {
        execution: "io",
        create,
      },
    },
  });
  expect(plugin.definition.nativePlatforms[platform]?.create).not.toBe(create);
  expect(Object.isFrozen(PLATFORMS)).toBe(true);
});

test("platform declarations remain detached from Core platform restrictions and validate support", () => {
  const operation = {
    input: z.null(),
    output: z.null(),
  };
  const supported = [
    "read",
  ];
  const create = () => ({
    execute: () => null,
    dispose() {},
  });
  const definition = {
    name: "demo",
    operations: {
      read: operation,
    },
    platforms: {
      windows: {
        execution: "io" as const,
        create,
        operations: supported,
      },
    },
  };
  const plugin = defineNativePlugin(definition);
  expect(plugin.definition.version).toBe("development");
  expect(Object.hasOwn(plugin.definition, "platforms")).toBe(false);
  expect(plugin.definition.nativePlatforms.windows?.create).not.toBe(create);
  expect(
    Object.keys(
      structuredClone(plugin.definition.nativePlatforms).windows ?? {},
    ),
  ).toEqual([
    "execution",
    "operations",
  ]);
  supported.push("missing");
  expect(plugin.definition.nativePlatforms.windows?.operations).toEqual([
    "read",
  ]);
  expect(Object.isFrozen(plugin.definition.nativePlatforms.windows)).toBe(true);
  for (const platforms of [
    {
      unknown: {
        execution: "io",
        create,
      },
    },
    {
      windows: {
        execution: "backend",
        create,
      },
    },
    {
      windows: {
        execution: "io",
        create: undefined,
      },
    },
    {
      windows: {
        execution: "io",
        create: "not a factory",
      },
    },
    {
      windows: {
        execution: "io",
        create,
        operations: [
          "missing",
        ],
      },
    },
    {
      windows: {
        execution: "io",
        create,
        operations: [
          "read",
          "read",
        ],
      },
    },
  ]) {
    expect(() =>
      Reflect.apply(defineNativePlugin, undefined, [
        {
          ...definition,
          platforms,
        },
      ]),
    ).toThrow();
  }
});
test("short declarations generate strict schemas and independently granted operations", async () => {
  const input = z.strictObject({
    level: z.enum([
      "info",
      "error",
    ]),
    message: z.string().max(4),
    details: z.json().exactOptional(),
    nested: z.strictObject({
      count: z.int().min(0),
      enabled: z.boolean(),
      names: z.array(z.string()).max(1),
    }),
  });
  const operation = {
    input,
    output: z.null(),
  };
  const plugin = defineNativePlugin({
    name: "audit",
    operations: {
      write: operation,
      repeat: operation,
    },
  });
  const parsers = pluginParsers("audit", {
    write: operation,
    repeat: operation,
  });
  const registry = new NativeRegistry([
    plugin.definition,
  ]);
  const payload: Parameters<typeof plugin.api.write>[0] = {
    level: "info",
    message: "ok",
    nested: {
      count: 0,
      enabled: true,
      names: [
        "a",
      ],
    },
  };
  expect(Object.keys(plugin.api)).toEqual([
    "write",
    "repeat",
  ]);
  expect([
    ...registry.operations.keys(),
  ]).toEqual([
    "audit.write",
    "audit.repeat",
  ]);
  expect([
    ...registry.operations.values(),
  ]).toEqual([
    {
      name: "audit.write",
    },
    {
      name: "audit.repeat",
    },
  ]);
  expect([
    ...registry.operations.keys(),
  ]).toEqual([
    "audit.write",
    "audit.repeat",
  ]);
  expect(
    (
      await parsers.validateCall({
        operation: "audit.write",
        payload,
      })
    ).payload,
  ).toEqual(payload);
  expect(
    (
      await parsers.validateCall({
        operation: "audit.write",
        payload: {
          ...payload,
          details: {
            tags: [
              null,
              true,
            ],
          },
        },
      })
    ).payload,
  ).toHaveProperty("details");
  for (const invalid of [
    {
      message: "ok",
      nested: payload.nested,
    },
    {
      ...payload,
      level: "debug",
    },
    {
      ...payload,
      message: "too long",
    },
    {
      ...payload,
      extra: true,
    },
    {
      ...payload,
      nested: {
        ...payload.nested,
        count: -1,
      },
    },
    {
      ...payload,
      nested: {
        ...payload.nested,
        enabled: "yes",
      },
    },
    {
      ...payload,
      nested: {
        ...payload.nested,
        names: [
          "a",
          "b",
        ],
      },
    },
  ]) {
    await expect(
      parsers.validateCall({
        operation: "audit.write",
        payload: invalid,
      }),
    ).rejects.toThrow();
  }
  expect(await parsers.validateOutput("audit.write", null)).toBeNull();
  await expect(parsers.validateOutput("audit.write", false)).rejects.toThrow();
  expect(
    defineNativePlugin({
      name: "audit",
      operations: {
        toString: operation,
      },
    }).definition.native.operations[0]?.name,
  ).toBe("audit.toString");
});
export function checkShortDeclarationTypes() {
  const plugin = defineNativePlugin({
    name: "example",
    operations: {
      write: {
        input: z.strictObject({
          level: z.enum([
            "info",
            "error",
          ]),
          message: z.string(),
          details: z.json().exactOptional(),
        }),
        output: z.null(),
      },
    },
  });
  const result: Promise<null> = plugin.api.write({
    level: "info",
    message: "ok",
  });
  void result;
  // @ts-expect-error required fields remain required
  plugin.api.write({
    level: "info",
  });
  plugin.api.write({
    // @ts-expect-error enum literals remain restricted
    level: "debug",
    message: "ok",
  });
  plugin.api.write({
    level: "info",
    message: "ok",
    // @ts-expect-error optional fields must still be JSON
    details: () => {},
  });
  const numeric = defineNativePlugin({
    name: "numbered",
    operations: {
      0: {
        input: z.strictObject({
          0: z.string(),
        }),
        output: z.null(),
      },
    },
  });
  void numeric.api[0]({
    0: "ok",
  });
  // @ts-expect-error numeric object keys are required too
  numeric.api[0]({});
}
const empty: Policy = {
  version: 1,
  views: [],
  backend: {
    permissions: [],
  },
};
test("plugin patterns use Unicode semantics for input and output", async () => {
  const letters = z.string().regex(/^\p{L}+$/u);
  const plugin = defineNativePlugin({
    name: "unicode",
    operations: {
      text: {
        input: letters,
        output: letters,
      },
    },
  });
  const parsers = pluginParsers("unicode", {
    text: {
      input: letters,
      output: letters,
    },
  });
  for (const text of [
    "abc",
    "한글",
    "𐐀",
  ]) {
    const call = await parsers.validateCall({
      operation: "unicode.text",
      payload: text,
    });
    expect(call.payload).toBe(text);
    expect(await parsers.validateOutput(call.operation, text)).toBe(text);
    const policy: Policy = {
      ...empty,
      backend: {
        permissions: [
          "unicode.text",
        ],
      },
    };
    new NativeRegistry([
      plugin.definition,
    ]).validatePolicy(policy);
    expect(
      new NativeRegistry([
        plugin.definition,
      ]).allowed(policy.backend, call),
    ).toBe(true);
  }
  for (const text of [
    "123",
    "p{L}",
  ]) {
    await expect(
      parsers.validateCall({
        operation: "unicode.text",
        payload: text,
      }),
    ).rejects.toThrow();
    await expect(
      parsers.validateOutput("unicode.text", text),
    ).rejects.toThrow();
  }
  const scalar = pluginParsers("scalar", {
    one: {
      input: z.string().regex(/^.$/u),
      output: z.null(),
    },
  });
  expect(
    (
      await scalar.validateCall({
        operation: "scalar.one",
        payload: "😀",
      })
    ).payload,
  ).toBe("😀");
  await expect(
    scalar.validateCall({
      operation: "scalar.one",
      payload: "ab",
    }),
  ).rejects.toThrow();
});
test("plugin results exceeding the Web envelope return INTERNAL and keep the session usable", async () => {
  const plugin = defineNativePlugin({
    name: "large",
    operations: {
      read: {
        input: z.int(),
        output: z.string(),
      },
    },
  });
  const id = "r".repeat(128);
  const protocol = {
    major: 1,
    minor: 0,
  };
  const overhead = Buffer.byteLength(
    serializeMessage({
      kind: "result",
      protocol,
      id,
      payload: "",
    }),
  );
  const tooLarge = "x".repeat(MAX_MESSAGE_BYTES - 30);
  const payloads = [
    tooLarge,
    "x".repeat(MAX_MESSAGE_BYTES - overhead),
    "ok",
  ];
  const oversized = hostResponse(() => tooLarge);
  expect(oversized.kind).toBe("result");
  expect(Buffer.byteLength(serializeHostResponse(oversized))).toBe(
    MAX_MESSAGE_BYTES,
  );
  const replies: ServerMessage[] = [];
  let sendFailures = 0;
  const adapter: CoreServices = {
    ...services({
      ...empty,
      views: [
        {
          id: "main",
          origins: [
            "https://app.bunaway.local",
          ],
          commands: [
            "plugin.large.read",
          ],
          events: [],
          host: {
            permissions: [
              "large.read",
            ],
          },
        },
      ],
    }),
    async callHost(_context, call) {
      const payload = payloads[call.payload as number];
      if (payload === undefined) {
        throw new Error("Missing fixture result.");
      }
      return hostResponse(() => payload);
    },
    async send(context, message) {
      try {
        validatePacket(
          {
            kind: "server",
            route: {
              context,
              viewId: "main",
              documentGeneration: 1,
            },
            message,
          },
          "ui",
        );
        serializeMessage(message);
        replies.push(message);
      } catch (error) {
        sendFailures++;
        throw error;
      }
    },
  };
  const core = await createCore(
    {
      commands: {},
      events: {},
      plugins: [
        plugin.definition,
      ],
    },
    adapter,
  );
  try {
    const session = core.openSession("view" as HostContext, "main");
    await session.receive(adapter.hello);
    for (let index = 0; index < payloads.length; index++) {
      const requestId = index === 1 ? id : `request-${index}`;
      await session.receive({
        kind: "invoke",
        protocol,
        id: requestId,
        command: "plugin.large.read",
        payload: index,
      });
      for (let turn = 0; turn < 20; turn++) {
        await Promise.resolve();
      }
      expect(sendFailures).toBe(0);
      const reply = replies.find(
        (message) => "id" in message && message.id === requestId,
      );
      expect(reply?.kind).toBe(index === 0 ? "error" : "result");
      if (index === 0 && reply?.kind === "error") {
        expect(reply.error.code).toBe("INTERNAL");
      }
      if (index === 1 && reply) {
        expect(Buffer.byteLength(serializeMessage(reply))).toBe(
          MAX_MESSAGE_BYTES,
        );
      }
      if (index === 2 && reply?.kind === "result") {
        expect(reply.payload).toBe("ok");
      }
    }
  } finally {
    await core.stop();
  }
});
function services(policy = empty): CoreServices {
  return {
    policy,
    platform: "windows",
    backendContext: "backend" as HostContext,
    hello: {
      kind: "hello",
      protocol: {
        major: 1,
        minor: 0,
      },
      features: [],
      buildId: "plugins",
    },
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
      return {
        kind: "result",
        payload: "saved",
      };
    },
  };
}
test("an app without native plugins has no host operations or implicit permissions", async () => {
  const registry = new NativeRegistry([]);
  expect(registry.operations.size).toBe(0);
  const core = await createCore(
    {
      commands: {},
      events: {},
    },
    services(),
  );
  await core.stop();
  await expect(
    bindHostAPI(
      "backend" as HostContext,
      new AbortController().signal,
      services().callHost,
      registry,
    ).call(readText, {
      path: "a.txt",
    }),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  expect(() =>
    registry.validatePolicy({
      ...empty,
      backend: {
        permissions: [
          "storage.readText",
        ],
      },
    }),
  ).toThrow();
});
test("backend host calls strip object fields before adapter execution and after its response", async () => {
  const plugin = defineNativePlugin({
    name: "example",
    platforms: {
      windows: {
        execution: "io",
        create: () => ({
          execute(_operation, input) {
            expect(input).toEqual({
              name: "ok",
            });
            return {
              name: "ok",
              extra: true,
            };
          },
          dispose() {},
        }),
      },
    },
    operations: {
      echo: {
        input: z.object({
          name: z.string(),
        }),
        output: z.object({
          name: z.string(),
        }),
      },
    },
  });
  const registry = new NativeRegistry([
    JSON.parse(JSON.stringify(plugin.definition)),
  ]);
  const operation = registry.operation("example.echo");
  const adapter = plugin.definition.nativePlatforms.windows?.create({
    dataRoot: ".",
    capabilities: [],
  });
  if (!adapter) {
    throw new Error("Missing adapter");
  }
  const api = bindHostAPI(
    "backend" as HostContext,
    new AbortController().signal,
    async (_context, call) => {
      expect(call.payload).toEqual({
        name: "ok",
        extra: true,
      });
      return {
        kind: "result",
        payload: await adapter.execute(call.operation, call.payload, "test"),
      };
    },
    registry,
  );
  const input = {
    name: "ok",
    extra: true,
  };
  expect(await api.call(operation, input)).toEqual({
    name: "ok",
  });
  expect(input.extra).toBe(true);
});

test("operation registration snapshots names and rejects schema or permission overrides", async () => {
  const plugin = {
    ...storagePlugin,
    native: structuredClone(storagePlugin.native),
  };
  const registry = new NativeRegistry([
    plugin,
  ]);
  const copied = plugin.native.operations[0];
  if (!copied) {
    throw new Error("Missing operation");
  }
  const original = copied.name;
  copied.name = "storage.changed";
  expect(registry.operation(original).name).toBe(original);
  expect(() => registry.operation("storage.changed")).toThrow();
  for (const extra of [
    {
      input: {},
    },
    {
      output: {},
    },
    {
      permission: "anything",
    },
  ]) {
    const operation = {
      ...readText,
      ...extra,
    };
    expect(
      () =>
        new NativeRegistry([
          {
            ...storagePlugin,
            native: {
              operations: [
                operation,
              ],
            },
          },
        ]),
    ).toThrow();
  }
  const api = bindHostAPI(
    "backend" as HostContext,
    new AbortController().signal,
    services().callHost,
    registry,
  );
  await expect(
    api.call(readText, {
      path: "a.txt",
    }),
  ).resolves.toBe("saved");
});

test("runtime registries keep aggregate limits while catalogs accept installed plugin sets", () => {
  const plugins = [
    "first",
    "second",
  ].map((name) => ({
    name,
    version: "1",
    native: {
      operations: Array.from(
        {
          length: 129,
        },
        (_, index) => ({
          name: `${name}.call${index}`,
        }),
      ),
    },
  }));
  expect(() => new NativeRegistry(plugins)).toThrow(
    "Plugin contract limit reached.",
  );
  expect(
    new NativeRegistry(plugins, {
      mode: "catalog",
    }).operations.size,
  ).toBe(258);
  expect(new NativeRegistry(plugins.slice(0, 1)).operations.size).toBe(129);
  expect(
    () =>
      new NativeRegistry(
        [
          {
            name: "too-many",
            version: "1",
            native: {
              operations: Array.from(
                {
                  length: 257,
                },
                (_, index) => ({
                  name: `too-many.call${index}`,
                }),
              ),
            },
          },
        ],
        {
          mode: "catalog",
        },
      ),
  ).toThrow();
});
test("native operation contracts reject separate permission and OS consent metadata", () => {
  for (const metadata of [
    {
      permission: "storage:read-text",
    },
    {
      osPermission: "not-required",
    },
    {
      scope: z.string(),
    },
  ]) {
    const invalid = {
      ...storagePlugin,
      native: {
        operations: [
          {
            ...readText,
            ...metadata,
          },
        ],
      },
    };
    expect(
      () =>
        new NativeRegistry([
          invalid,
        ]),
    ).toThrow();
  }
});
test("operation grants contain names only and apply independently of app resource rules", () => {
  const registry = new NativeRegistry([
    storagePlugin,
  ]);
  const policy: Policy = {
    ...empty,
    backend: {
      permissions: [
        writeText.name,
      ],
    },
  };
  registry.validatePolicy(policy);
  for (const path of [
    "notes/a.txt",
    "private/a.txt",
  ]) {
    const call = registry.validateCall({
      operation: writeText.name,
      payload: {
        path,
        text: "saved",
      },
    });
    expect(registry.allowed(policy.backend, call)).toBe(true);
    expect(
      registry.allowed(
        {
          permissions: [],
        },
        call,
      ),
    ).toBe(false);
  }
  expect(
    registry.allowed(policy.backend, {
      operation: readText.name,
      payload: {
        path: "notes/a.txt",
      },
    }),
  ).toBe(false);
  expect(() =>
    parsePolicy(
      JSON.stringify({
        ...empty,
        backend: {
          permissions: [
            {
              identifier: writeText.name,
              allow: [
                {
                  pathPrefix: "notes",
                },
              ],
            },
          ],
        },
      }),
    ),
  ).toThrow();
  expect(() =>
    registry.validatePolicy({
      ...empty,
      backend: {
        permissions: [
          "storage.missing",
        ],
      },
    }),
  ).toThrow("unregistered operation");
});
test("native bridges require view command permission and distinguish missing plugins", async () => {
  const replies: ServerMessage[] = [];
  const policy: Policy = {
    ...empty,
    views: [
      {
        id: "main",
        origins: [
          "https://app.bunaway.local",
        ],
        commands: [
          "plugin.storage.readText",
        ],
        events: [],
        host: {
          permissions: [],
        },
      },
    ],
  };
  const adapter: CoreServices = {
    ...services(policy),
    send: async (_context, reply) => {
      replies.push(reply);
    },
  };
  const core = await createCore(
    {
      commands: {},
      events: {},
    },
    adapter,
  );
  const session = core.openSession("view" as HostContext, "main");
  await session.receive(adapter.hello);
  for (const [id, command] of [
    [
      "missing",
      "plugin.storage.readText",
    ],
    [
      "denied",
      "plugin.log.write",
    ],
  ]) {
    await session.receive({
      kind: "invoke",
      protocol: adapter.hello.protocol,
      id: id ?? "",
      command: command ?? "",
      payload: null,
    });
  }
  expect(replies).toContainEqual(
    expect.objectContaining({
      id: "missing",
      error: expect.objectContaining({
        code: "UNSUPPORTED",
      }),
    }),
  );
  expect(replies).toContainEqual(
    expect.objectContaining({
      id: "denied",
      error: expect.objectContaining({
        code: "PERMISSION_DENIED",
      }),
    }),
  );
  await core.stop();
});
test("unified plugin imports select browser and Bun implementations without leaking native code", async () => {
  for (const plugin of [
    "windows",
    "storage",
    "log",
    "capabilities",
  ]) {
    for (const target of [
      "browser",
      "bun",
    ] as const) {
      const result = await Bun.build({
        entrypoints: [
          "unified-plugin-entry",
        ],
        target,
        metafile: true,
        plugins: [
          {
            name: "unified-plugin-test",
            setup(build) {
              build.onResolve(
                {
                  filter: /^unified-plugin-entry$/,
                },
                () => ({
                  path: resolve(
                    import.meta.dir,
                    "../fixtures/desktop/host/unified-plugin.ts",
                  ),
                  namespace: "file",
                }),
              );
              build.onLoad(
                {
                  filter: /unified-plugin\.ts$/,
                },
                () => ({
                  contents: `export * from "@bunaway/plugin-${plugin}";`,
                  loader: "ts",
                  resolveDir: resolve(
                    import.meta.dir,
                    "../fixtures/desktop/host",
                  ),
                }),
              );
            },
          },
        ],
      });
      expect(result.success).toBe(true);
      const output = result.outputs[0];
      if (!output || !result.metafile) {
        throw new Error("Missing plugin bundle.");
      }
      const source = await output.text();
      const inputs = Object.keys(result.metafile.inputs);
      expect(
        inputs.some((name) => name.endsWith(`plugins/${plugin}/dist/index.js`)),
      ).toBe(true);
      expect(
        inputs.some((name) =>
          /\/native\/windows\/|\/src\/platforms\/|\/dist\/native\//.test(name),
        ),
      ).toBe(false);
      expect(
        inputs.some((name) =>
          name.endsWith(
            `plugin-sdk/src/${target === "browser" ? "browser" : "bun"}.ts`,
          ),
        ),
      ).toBe(true);
      if (target === "browser") {
        for (const name of [
          "AsyncLocalStorage",
          "node:async_hooks",
          "bun:ffi",
          "kernel32.dll",
        ]) {
          expect(source).not.toContain(name);
        }
        expect(inputs.some((name) => /backend-sdk/.test(name))).toBe(false);
      } else {
        expect(inputs.some((name) => /client-sdk/.test(name))).toBe(false);
      }
    }
  }
});
