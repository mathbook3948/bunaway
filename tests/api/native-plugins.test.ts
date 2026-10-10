import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { validatePacket } from "#native/windows/bun/channel";
import { hostResponse } from "#native/windows/bun/host-response";
import { bindHostAPI, type CoreServices, createCore } from "@bunaway/core";
import { defineNativePlugin, s } from "@bunaway/plugin";
import {
  type HostContext,
  MAX_MESSAGE_BYTES,
  NativeRegistry,
  type Policy,
  type ServerMessage,
  serializeHostResponse,
  serializeMessage,
} from "@bunaway/protocol";
import { storagePlugin } from "@bunaway/plugin-storage";
import { contracts } from "../fixtures/host-plugins.ts";

const readText = contracts["storage.readText"];
const writeText = contracts["storage.writeText"];
const matches = storagePlugin.matches;

test("short declarations generate strict schemas, qualified names and shared permissions", () => {
  const input = s.object({
    level: s.enum([
      "info",
      "error",
    ]),
    message: s.string({
      maxLength: 4,
    }),
    details: s.optional(s.json()),
    nested: s.object({
      count: s.integer({
        minimum: 0,
      }),
      enabled: s.boolean(),
      names: s.array(s.string(), {
        maxItems: 1,
      }),
    }),
  });
  const operation = {
    input,
    output: s.null(),
    permission: "record",
    osPermission: "not-required" as const,
  };
  const plugin = defineNativePlugin({
    name: "audit",
    version: "1",
    operations: {
      write: operation,
      repeat: operation,
    },
    scopes: {
      record: s.object({
        prefix: s.string(),
      }),
    },
    matches: () => true,
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
  expect(
    [
      ...registry.operations.values(),
    ].map(({ osPermission }) => osPermission),
  ).toEqual([
    "not-required",
    "not-required",
  ]);
  expect([
    ...registry.permissions.keys(),
  ]).toEqual([
    "audit:record",
  ]);
  expect(
    registry.validateCall({
      operation: "audit.write",
      payload,
    }).payload,
  ).toEqual(payload);
  expect(
    registry.validateCall({
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
    }).payload,
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
    expect(() =>
      registry.validateCall({
        operation: "audit.write",
        payload: invalid,
      }),
    ).toThrow();
  }
  expect(registry.validateOutput("audit.write", null)).toBeNull();
  expect(() => registry.validateOutput("audit.write", false)).toThrow();
  expect(
    defineNativePlugin({
      name: "audit",
      version: "1",
      operations: {
        write: {
          ...operation,
          permission: "toString",
        },
      },
      scopes: {},
    }).definition.native.permissions,
  ).toEqual([
    {
      name: "audit:toString",
    },
  ]);
  expect(() =>
    defineNativePlugin({
      name: "audit",
      version: "1",
      operations: {
        write: operation,
      },
      scopes: {
        unused: s.string(),
      },
    }),
  ).toThrow("unused permission");
  expect(() =>
    defineNativePlugin({
      name: "audit",
      version: "1",
      operations: {
        write: operation,
      },
      scopes: {
        record: s.string(),
      },
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
          level: s.enum([
            "info",
            "error",
          ]),
          message: s.string(),
          details: s.optional(s.json()),
        }),
        output: s.null(),
        permission: "write",
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
    version: "1",
    operations: {
      0: {
        input: s.object({
          0: s.string(),
        }),
        output: s.null(),
        permission: "call",
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

test("plugin patterns use Unicode semantics for input, output and permission scopes", () => {
  const letters = s.string({
    pattern: "^\\p{L}+$",
  });
  const plugin = defineNativePlugin({
    name: "unicode",
    version: "1",
    operations: {
      text: {
        input: letters,
        output: letters,
        permission: "text",
      },
    },
    scopes: {
      text: letters,
    },
    matches: (_permission, input, scope) => input === scope,
  });
  const registry = new NativeRegistry([
    plugin.definition,
  ]);
  for (const text of [
    "abc",
    "한글",
    "𐐀",
  ]) {
    const call = registry.validateCall({
      operation: "unicode.text",
      payload: text,
    });
    expect(call.payload).toBe(text);
    expect(registry.validateOutput(call.operation, text)).toBe(text);
    const policy: Policy = {
      ...empty,
      backend: {
        permissions: [
          {
            identifier: "unicode:text",
            allow: [
              text,
            ],
          },
        ],
      },
    };
    registry.validatePolicy(policy);
    expect(
      registry.allowed(policy.backend, call, plugin.definition.matches),
    ).toBe(true);
  }
  for (const text of [
    "123",
    "p{L}",
  ]) {
    expect(() =>
      registry.validateCall({
        operation: "unicode.text",
        payload: text,
      }),
    ).toThrow();
    expect(() => registry.validateOutput("unicode.text", text)).toThrow();
    expect(() =>
      registry.validatePolicy({
        ...empty,
        backend: {
          permissions: [
            {
              identifier: "unicode:text",
              allow: [
                text,
              ],
            },
          ],
        },
      }),
    ).toThrow();
  }
  const scalar = defineNativePlugin({
    name: "scalar",
    version: "1",
    operations: {
      one: {
        input: s.string({
          pattern: "^.$",
        }),
        output: s.null(),
        permission: "one",
      },
    },
  });
  expect(
    new NativeRegistry([
      scalar.definition,
    ]).validateCall({
      operation: "scalar.one",
      payload: "😀",
    }).payload,
  ).toBe("😀");
});

test("plugin results exceeding the Web envelope return INTERNAL and keep the session usable", async () => {
  const plugin = defineNativePlugin({
    name: "large",
    version: "1",
    operations: {
      read: {
        input: s.integer(),
        output: s.string(),
        permission: "read",
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
              "large:read",
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
      scope: "temp",
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
          "storage:read-text",
        ],
      },
    }),
  ).toThrow();
});

test("canonical contracts reject caller schema and permission overrides and copy registration", async () => {
  const plugin = {
    ...storagePlugin,
    native: structuredClone(storagePlugin.native),
  };
  const registry = new NativeRegistry([
    plugin,
  ]);
  const copied = plugin.native.operations[0];
  if (!copied) {
    throw new Error("Missing copied operation.");
  }
  (
    copied.input as {
      required: readonly string[];
    }
  ).required = [];
  const api = bindHostAPI(
    "backend" as HostContext,
    new AbortController().signal,
    services().callHost,
    registry,
  );
  await expect(
    api.call(
      {
        ...readText,
        input: {},
        permission: "log:write",
      },
      null,
    ),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(
    await api.call(readText, {
      scope: "temp",
      path: "a.txt",
    }),
  ).toBe("saved");
  expect(
    () =>
      new NativeRegistry([
        {
          ...storagePlugin,
          native: {
            ...storagePlugin.native,
            operations: [
              {
                ...readText,
                input: {
                  $ref: "ignored",
                } as never,
              },
            ],
          },
        },
      ]),
  ).toThrow();
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
          permission: `${name}:call`,
          input: {
            const: null,
          },
          output: {
            const: null,
          },
        }),
      ),
      permissions: [
        {
          name: `${name}:call`,
        },
      ],
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

  const permissionHeavy = [
    "first",
    "second",
  ].map((name) => ({
    name,
    version: "1",
    native: {
      operations: [
        {
          name: `${name}.call`,
          permission: `${name}:permission0`,
          input: {
            const: null,
          },
          output: {
            const: null,
          },
        },
      ],
      permissions: Array.from(
        {
          length: 129,
        },
        (_, index) => ({
          name: `${name}:permission${index}`,
        }),
      ),
    },
  }));
  expect(() => new NativeRegistry(permissionHeavy)).toThrow(
    "Plugin contract limit reached.",
  );
  expect(
    new NativeRegistry(permissionHeavy, {
      mode: "catalog",
    }).permissions.size,
  ).toBe(258);
  expect(
    () =>
      new NativeRegistry(
        [
          {
            name: "too-many",
            version: "1",
            native: {
              permissions: [
                {
                  name: "too-many:call",
                },
              ],
              operations: Array.from(
                {
                  length: 257,
                },
                (_, index) => ({
                  name: `too-many.call${index}`,
                  permission: "too-many:call",
                  input: {
                    const: null,
                  },
                  output: {
                    const: null,
                  },
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

test("native operation OS permission metadata is copied only for the supported literal", () => {
  const operation = {
    ...readText,
    osPermission: "not-required" as const,
  };
  const native = {
    ...storagePlugin.native,
    operations: [
      operation,
    ],
  };
  const registry = new NativeRegistry([
    {
      ...storagePlugin,
      native,
    },
  ]);
  expect(registry.operation(operation.name).osPermission).toBe("not-required");
  expect(
    () =>
      new NativeRegistry([
        {
          ...storagePlugin,
          native: {
            ...native,
            operations: [
              {
                ...operation,
                osPermission: "unrestricted" as never,
              },
            ],
          },
        },
      ]),
  ).toThrow();
});

test("scoped permissions aggregate allows, deny wins, and invalid scopes fail startup", () => {
  const registry = new NativeRegistry([
    storagePlugin,
  ]);
  const policy: Policy = {
    ...empty,
    backend: {
      permissions: [
        {
          identifier: writeText.permission,
          allow: [
            {
              scope: "appData",
              pathPrefix: "notes",
            },
          ],
        },
        {
          identifier: writeText.permission,
          allow: [
            {
              scope: "temp",
              pathPrefix: "notes",
            },
          ],
          deny: [
            {
              scope: "appData",
              pathPrefix: "notes/private",
            },
          ],
        },
      ],
    },
  };
  registry.validatePolicy(policy);
  const allowed = (scope: string, path: string) =>
    registry.allowed(
      policy.backend,
      {
        operation: writeText.name,
        payload: {
          scope,
          path,
          text: "saved",
        },
      },
      matches,
    );
  expect(allowed("appData", "notes/a.txt")).toBe(true);
  expect(allowed("temp", "notes/a.txt")).toBe(true);
  expect(allowed("appData", "notes/private/a.txt")).toBe(false);
  expect(allowed("appData", "notes-other/a.txt")).toBe(false);
  for (const permissions of [
    [
      writeText.permission,
    ],
    [
      {
        identifier: writeText.permission,
        allow: [
          {
            scope: "appData",
            pathPrefix: "../escape",
          },
        ],
      },
    ],
    [
      {
        identifier: writeText.permission,
        allow: [
          {
            scope: "root",
            pathPrefix: "",
          },
        ],
      },
    ],
  ]) {
    expect(() =>
      registry.validatePolicy({
        ...empty,
        backend: {
          permissions,
        },
      }),
    ).toThrow();
  }
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
        inputs.some((name) => name.endsWith(`plugins/${plugin}/src/index.ts`)),
      ).toBe(true);
      expect(inputs.some((name) => /\/windows(?:\/|\.ts$)/.test(name))).toBe(
        false,
      );
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
