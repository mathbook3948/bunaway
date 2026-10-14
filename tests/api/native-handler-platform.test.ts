import { expect, expectTypeOf, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import {
  defineNativeOperation,
  defineNativePlugin,
  type NativeHandlerContext,
} from "@bunaway/plugin";
import { z } from "zod";

const environment = {
  dataRoot: ".",
  capabilities: [],
};

test("operation declarations preserve synchronous and asynchronous handler return types", () => {
  const operation = defineNativeOperation<undefined>();
  const sync = operation({
    input: z.string(),
    output: z.string(),
    handler: (input) => input,
  });
  const asyncOperation = operation({
    input: z.string(),
    output: z.string(),
    handler: async (input) => input,
  });
  expectTypeOf<ReturnType<typeof sync.handler>>().toEqualTypeOf<string>();
  expectTypeOf<ReturnType<typeof asyncOperation.handler>>().toEqualTypeOf<
    Promise<string>
  >();
  expect(sync.handler("value")).toBe("value");
});

test("platform operations infer caller schemas, state and event literals", async () => {
  const operation = defineNativeOperation<{
    count: number;
  }>();
  const plugin = defineNativePlugin({
    name: "typed",
    events: {
      "typed.changed": {
        type: "string",
      },
    },
    platforms: {
      windows: {
        initialize: () => ({
          count: 0,
        }),
        dispose(instance: { count: number }) {
          expectTypeOf(instance).toEqualTypeOf<{
            count: number;
          }>();
        },
        operations: {
          run: operation({
            input: z.string().transform((value) => value.length),
            output: z.int().transform((value) => `length:${value}`),
            handler(input, context) {
              expectTypeOf(input).toEqualTypeOf<number>();
              expectTypeOf(context.instance).toEqualTypeOf<{
                count: number;
              }>();
              context.instance.count++;
              return input;
            },
          }),
        },
      },
      macos: {
        thread: "ui",
        operations: {
          run: {
            input: z.string().transform((value) => value.length),
            output: z.int().transform((value) => `length:${value}`),
            handler: async (
              input: number,
              context: NativeHandlerContext<undefined>,
            ) => {
              expect(context.instance).toBeUndefined();
              return input;
            },
          },
        },
      },
    },
  });
  expectTypeOf<Parameters<typeof plugin.api.run>[0]>().toEqualTypeOf<string>();
  expectTypeOf<
    Awaited<ReturnType<typeof plugin.api.run>>
  >().toEqualTypeOf<string>();
  expectTypeOf<typeof plugin.definition.name>().toEqualTypeOf<"typed">();
  expectTypeOf<
    (typeof plugin.definition.events)["typed.changed"]["type"]
  >().toEqualTypeOf<"string">();
  expect(plugin.definition.nativePlatforms.windows?.thread).toBe("worker");
  expect(plugin.definition.nativePlatforms.macos?.thread).toBe("ui");
  for (const os of [
    "windows",
    "macos",
  ] as const) {
    const target = plugin.definition.nativePlatforms[os];
    assert(target);
    expect(target.operations).toEqual([
      "run",
    ]);
    const adapter = target.create(environment);
    try {
      expect(await adapter.execute("typed.run", "hello", "backend")).toBe(
        "length:5",
      );
    } finally {
      await adapter.dispose();
    }
  }
});

test("each platform parses its own schemas and the public API collects operation names", async () => {
  const { definition, api } = defineNativePlugin({
    name: "local",
    platforms: {
      windows: {
        operations: {
          run: {
            input: z.string(),
            output: z.string(),
            handler: (value: string) => value,
          },
        },
      },
      macos: {
        operations: {
          run: {
            input: z.int(),
            output: z.int(),
            handler: (value: number) => value + 1,
          },
          macOnly: {
            input: z.null(),
            output: z.null(),
            handler: () => null,
          },
        },
      },
    },
  });
  expectTypeOf<Parameters<typeof api.run>[0]>().toEqualTypeOf<
    string | number
  >();
  expectTypeOf<Awaited<ReturnType<typeof api.run>>>().toEqualTypeOf<
    string | number
  >();
  expect(Object.keys(api)).toEqual([
    "run",
    "macOnly",
  ]);
  const windows = definition.nativePlatforms.windows?.create(environment);
  const macos = definition.nativePlatforms.macos?.create(environment);
  assert(windows && macos);
  try {
    expect(await windows.execute("local.run", "hello", "backend")).toBe(
      "hello",
    );
    expect(await macos.execute("local.run", 3, "backend")).toBe(4);
    await expect(
      windows.execute("local.run", 3, "backend"),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      macos.execute("local.run", "hello", "backend"),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      windows.execute("local.macOnly", null, "backend"),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  } finally {
    await windows.dispose();
    await macos.dispose();
  }
});

test("support is static and per-instance parsing, context and cleanup run once", async () => {
  let initializations = 0,
    disposals = 0,
    inputs = 0,
    outputs = 0;
  const operations = {
    echo: {
      input: z.string().transform(async (value) => {
        inputs++;
        return value.trim();
      }),
      output: z.string().transform(async (value) => {
        outputs++;
        return value.toUpperCase();
      }),
      handler: async (
        input: string,
        context: NativeHandlerContext<{
          count: number;
        }>,
      ) => {
        expect(input).toBe("hello");
        expect(context.source).toBe("view:main");
        expect(context.requestId).toBe("request");
        expect(context.permissions?.permissions).toEqual([
          "demo.echo",
        ]);
        context.signal?.throwIfAborted();
        context.instance.count++;
        return input;
      },
    },
    count: {
      input: z.null(),
      output: z.int(),
      handler: (
        _input: null,
        {
          instance,
        }: NativeHandlerContext<{
          count: number;
        }>,
      ) => instance.count,
    },
  };
  const { definition } = defineNativePlugin({
    name: "demo",
    platforms: {
      windows: {
        initialize: () => ({
          id: ++initializations,
          count: 0,
        }),
        dispose: () => {
          disposals++;
        },
        operations,
      },
    },
  });
  expect(initializations).toBe(0);
  expect(
    JSON.parse(JSON.stringify(definition)).nativePlatforms.windows.operations,
  ).toEqual([
    "echo",
    "count",
  ]);
  const target = definition.nativePlatforms.windows;
  assert(target);
  const adapter = target.create(environment),
    other = target.create(environment);
  assert(adapter.executeUI);
  const context = {
    requestId: "request",
    permissions: {
      permissions: [
        "demo.echo",
      ],
    },
    signal: new AbortController().signal,
  };
  try {
    expect(
      await adapter.executeUI("demo.echo", " hello ", "view:main", context),
    ).toBe("HELLO");
    expect(inputs).toBe(1);
    expect(outputs).toBe(1);
    expect(await adapter.execute("demo.count", null, "backend")).toBe(1);
    expect(await other.execute("demo.count", null, "backend")).toBe(0);
    await expect(
      adapter.execute("demo.missing", null, "backend"),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    await adapter.dispose();
    await adapter.dispose();
    expect(disposals).toBe(1);
    await expect(
      adapter.execute("demo.count", null, "backend"),
    ).rejects.toMatchObject({
      code: "CANCELLED",
    });
  } finally {
    await adapter.dispose();
    await other.dispose();
  }
  expect(disposals).toBe(2);
});

test("stateless operations retain safe input and output errors", async () => {
  const { definition } = defineNativePlugin({
    name: "stateless",
    platforms: {
      windows: {
        operations: {
          run: {
            input: z.null(),
            output: z.int().min(0),
            handler: (
              _input: null,
              context: NativeHandlerContext<undefined>,
            ) => {
              expect(context.instance).toBeUndefined();
              return -1;
            },
          },
        },
      },
    },
  });
  const adapter = definition.nativePlatforms.windows?.create(environment);
  assert(adapter);
  try {
    await expect(
      adapter.execute("stateless.run", null, "backend"),
    ).rejects.toMatchObject({
      code: "INTERNAL",
    });
    await expect(
      adapter.execute("stateless.run", false, "backend"),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  } finally {
    await adapter.dispose();
  }
});

test("invalid platform operations and mixed authoring styles fail before initialization", () => {
  const run = {
    input: z.null(),
    output: z.null(),
    handler: () => null,
  };
  const declarations = [
    {
      name: "invalid",
      platforms: {
        windows: {
          operations: {
            run: {
              ...run,
              handler: null,
            },
          },
        },
      },
    },
    {
      name: "invalid",
      platforms: {
        windows: {
          operations: {
            run: {
              ...run,
              input: {},
            },
          },
        },
      },
    },
    {
      name: "invalid",
      platforms: {
        windows: {
          operations: [],
        },
      },
    },
    {
      name: "invalid",
      platforms: {
        unknown: {
          operations: {
            run,
          },
        },
      },
    },
    {
      name: "invalid",
      operations: {
        run,
      },
      platforms: {
        windows: {
          operations: {
            run,
          },
        },
      },
    },
    {
      name: "invalid",
      platforms: {
        windows: {
          operations: {
            run,
          },
          create: () => ({
            execute: () => null,
            dispose() {},
          }),
        },
      },
    },
  ];
  for (const declaration of declarations) {
    expect(() =>
      Reflect.apply(defineNativePlugin, undefined, [
        declaration,
      ]),
    ).toThrow();
  }
});

test("synchronous cleanup failures remain observable and retryable", async () => {
  let cleanups = 0;
  const { definition } = defineNativePlugin({
    name: "cleanup",
    platforms: {
      windows: {
        operations: {
          run: {
            input: z.null(),
            output: z.null(),
            handler: () => null,
          },
        },
        dispose() {
          cleanups++;
          throw new Error("cleanup failed");
        },
      },
    },
  });
  const adapter = definition.nativePlatforms.windows?.create(environment);
  assert(adapter);
  await expect(adapter.dispose()).rejects.toThrow("cleanup failed");
  await expect(adapter.dispose()).rejects.toThrow("cleanup failed");
  expect(cleanups).toBe(2);
});

test("concurrent cleanup shares pending work, retries rejection and retains success", async () => {
  let cleanups = 0;
  const firstAttempt = Promise.withResolvers<void>();
  const { definition } = defineNativePlugin({
    name: "retry",
    platforms: {
      windows: {
        operations: {
          run: {
            input: z.null(),
            output: z.null(),
            handler: () => null,
          },
        },
        dispose() {
          cleanups++;
          return cleanups === 1 ? firstAttempt.promise : undefined;
        },
      },
    },
  });
  const adapter = definition.nativePlatforms.windows?.create(environment);
  assert(adapter);
  const first = adapter.dispose();
  expect(adapter.dispose()).toBe(first);
  firstAttempt.reject(new Error("cleanup failed"));
  await expect(first).rejects.toThrow("cleanup failed");
  expect(cleanups).toBe(1);
  await expect(
    adapter.execute("retry.run", null, "backend"),
  ).rejects.toMatchObject({
    code: "CANCELLED",
  });
  const retry = adapter.dispose();
  expect(adapter.dispose()).toBe(retry);
  await retry;
  expect(adapter.dispose()).toBe(retry);
  expect(cleanups).toBe(2);
});

test.each([
  "async",
  "promise",
  "thenable",
] as const)(
  "%s initialization is rejected and late instances are cleaned without executing handlers",
  async (kind) => {
    const initialization = Promise.withResolvers<{
      resource: string;
    }>();
    const cleaned = Promise.withResolvers<unknown>();
    let calls = 0;
    const initialize =
      kind === "async"
        ? async () => await initialization.promise
        : () => {
            if (kind === "promise") {
              return initialization.promise;
            }
            return {
              // biome-ignore lint/suspicious/noThenProperty: Exercise rejection of non-Promise thenables.
              then: initialization.promise.then.bind(initialization.promise),
            };
          };
    const declaration = {
      name: "invalidInit",
      platforms: {
        windows: {
          initialize,
          dispose: (instance: unknown) => {
            cleaned.resolve(instance);
          },
          operations: {
            run: {
              input: z.null(),
              output: z.null(),
              handler: () => {
                calls++;
                return null;
              },
            },
          },
        },
      },
    };
    // @ts-expect-error asynchronous initializers cannot satisfy the synchronous activation contract.
    const { definition } = defineNativePlugin(declaration);
    const platform = definition.nativePlatforms.windows;
    assert(platform);
    expect(() => platform.create(environment)).toThrow(
      "initialize must return synchronously",
    );
    expect(calls).toBe(0);
    const instance = {
      resource: "late resource",
    };
    initialization.resolve(instance);
    expect(await cleaned.promise).toBe(instance);
  },
);

test.each([
  "initialize",
  "dispose",
] as const)(
  "invalid asynchronous initialization observes late %s failures",
  async (stage) => {
    const failure = new Error("late failure");
    const reported = Promise.withResolvers<unknown>();
    const diagnostic = spyOn(console, "error").mockImplementation(
      (_message, error) => {
        reported.resolve(error);
      },
    );
    try {
      const declaration = {
        name: "failedInit",
        platforms: {
          windows: {
            initialize: async () => {
              if (stage === "initialize") {
                throw failure;
              }
              return null;
            },
            dispose() {
              throw failure;
            },
            operations: {},
          },
        },
      };
      // @ts-expect-error rejected promises must not escape through a typed initializer either.
      const { definition } = defineNativePlugin(declaration);
      const platform = definition.nativePlatforms.windows;
      assert(platform);
      expect(() => platform.create(environment)).toThrow(
        "initialize must return synchronously",
      );
      expect(await reported.promise).toBe(failure);
    } finally {
      diagnostic.mockRestore();
    }
  },
);

test("platform busy state follows its own instance", async () => {
  const { definition } = defineNativePlugin({
    name: "busy",
    platforms: {
      windows: {
        initialize: () => ({
          pending: false,
        }),
        busy: (instance: { pending: boolean }) => instance.pending,
        operations: {
          start: {
            input: z.null(),
            output: z.null(),
            handler: (
              _input: null,
              {
                instance,
              }: NativeHandlerContext<{
                pending: boolean;
              }>,
            ) => {
              instance.pending = true;
              return null;
            },
          },
        },
      },
    },
  });
  const platform = definition.nativePlatforms.windows;
  assert(platform);
  const first = platform.create(environment);
  const second = platform.create(environment);
  try {
    expect(first.busy?.()).toBe(false);
    expect(second.busy?.()).toBe(false);
    await first.execute("busy.start", null, "backend");
    expect(first.busy?.()).toBe(true);
    expect(second.busy?.()).toBe(false);
  } finally {
    await first.dispose();
    await second.dispose();
  }
});
