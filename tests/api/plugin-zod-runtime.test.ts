import { expect, expectTypeOf, test } from "bun:test";
import { Worker } from "node:worker_threads";
import {
  defineNativePlugin,
  type NativeAdapter,
  type NativeEnvironment,
} from "@bunaway/plugin";
import type { HostContext } from "@bunaway/protocol";
import {
  type JsonValue,
  MAX_JSON_DEPTH,
  MAX_MESSAGE_BYTES,
  NativeRegistry,
  validateValue,
} from "@bunaway/protocol";
import { z } from "zod";
import { bindHostAPI } from "#core/host-api";
import { hostResponse } from "#native/host-api/bun/host-response";
import { operations } from "#native/host-api/bun/plugins";
import { assertZodWorker } from "../fixtures/assert-zod-worker.ts";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const environment: NativeEnvironment = {
  dataRoot: ".",
  capabilities: [],
};

test("Zod owns acceptance and normalized values at both plugin parsing boundaries", async () => {
  const when = {
    abort: false,
    when: ({ value }: { value: unknown }) => value !== 0,
  };
  const cases: {
    schema: z.ZodType;
    values: JsonValue[];
  }[] = [
    {
      schema: z.record(z.string(), z.string()),
      values: [
        JSON.parse('{"__proto__":"x","a":"ok"}'),
        {
          a: 1,
        },
      ],
    },
    {
      schema: z.record(z.literal("__proto__"), z.string()),
      values: [
        {},
        JSON.parse('{"__proto__":42}'),
        {
          a: "bad",
        },
      ],
    },
    {
      schema: z.partialRecord(z.literal(1), z.string()),
      values: [
        {
          "01": "ok",
        },
        {
          "1.0": "ok",
        },
        {
          "2": "bad",
        },
      ],
    },
    {
      schema: z.record(z.int().min(5), z.string()),
      values: [
        {
          "6": "ok",
        },
        {
          "3": "bad",
        },
      ],
    },
    {
      schema: z.record(
        z.enum([
          "a",
          "b",
        ]),
        z.string().exactOptional(),
      ),
      values: [
        {},
        {
          a: "x",
          b: "y",
        },
      ],
    },
    {
      schema: z.looseRecord(z.literal("a"), z.string()),
      values: [
        {
          a: "ok",
          extra: 1,
        },
        {
          a: 1,
        },
      ],
    },
    {
      schema: z.number().check(z.gte(10, when)),
      values: [
        0,
        5,
        10,
      ],
    },
    {
      schema: z
        .enum([
          "a",
          "bb",
        ])
        .check(z.minLength(2)),
      values: [
        "a",
        "bb",
      ],
    },
    {
      schema: z.stringFormat("time", (value) => value === "12:00"),
      values: [
        "12:00",
        "bad",
      ],
    },
    {
      schema: z.templateLiteral([
        z.string().regex(/^.$/u),
      ]),
      values: [
        "a",
        "😀",
      ],
    },
    {
      schema: z.string().regex(/^ok$/i),
      values: [
        "OK",
        "bad",
      ],
    },
    {
      schema: z.object({
        name: z.string(),
      }),
      values: [
        {
          name: "ok",
          extra: 1,
        },
        {
          name: 3,
        },
      ],
    },
    {
      schema: z
        .string()
        .trim()
        .transform((value) => value.toUpperCase()),
      values: [
        " ok ",
        42,
      ],
    },
    {
      schema: z.literal([
        Infinity,
        true,
      ]),
      values: [
        true,
        null,
      ],
    },
  ];
  const recursive: z.ZodType = z.lazy(() =>
    z.object({
      value: z.string(),
      children: z.array(recursive),
    }),
  );
  cases.push({
    schema: recursive,
    values: [
      {
        value: "ok",
        children: [],
        extra: true,
      },
      {
        value: 1,
        children: [],
      },
    ],
  });
  for (const { schema, values } of cases) {
    const parsers = pluginParsers("test", {
      echo: {
        input: schema,
        output: schema,
      },
    });
    for (const value of values) {
      const original = structuredClone(value);
      const expected = schema.safeParse(value);
      for (const run of [
        async () =>
          (
            await parsers.validateCall({
              operation: "test.echo",
              payload: value,
            })
          ).payload,
        async () => await parsers.validateOutput("test.echo", value),
      ]) {
        if (expected.success) {
          expect(expected.data).toEqual(await run());
        } else {
          await expect(run()).rejects.toThrow();
        }
      }
      expect(value).toEqual(original);
    }
  }
});

test("host forwarding runs each parser once and adapters receive parsed input", async () => {
  let inputCalls = 0;
  let outputCalls = 0;
  let executions = 0;
  let disposed = 0;
  const plugin = defineNativePlugin({
    name: "counter",
    operations: {
      increment: {
        input: z.number().transform((value) => {
          inputCalls++;
          return value + 1;
        }),
        output: z.number().transform((value) => {
          outputCalls++;
          return value + 10;
        }),
      },
    },
    platforms: {
      windows: {
        thread: "worker",
        create: () => ({
          execute(_name, input) {
            executions++;
            expect(input).toBe(2);
            return input;
          },
          dispose() {
            disposed++;
          },
        }),
      },
    },
  });
  expect(inputCalls + outputCalls + executions).toBe(0);
  const registration = JSON.parse(JSON.stringify(plugin._definition));
  expect(registration.native.operations).toEqual([
    {
      name: "counter.increment",
    },
  ]);
  const target = plugin._definition.nativePlatforms.windows;
  if (!target) {
    throw new Error("Missing platform");
  }
  const dispatcher = await operations(
    [
      registration,
    ],
    ".",
    "worker",
    undefined,
    [
      {
        ...registration,
        thread: "worker",
        operations: async () => ({
          createOperations: target.create,
        }),
      },
    ],
  );
  try {
    const registry = new NativeRegistry([
      registration,
    ]);
    const api = bindHostAPI(
      "backend" as HostContext,
      new AbortController().signal,
      async (_context, call) => {
        try {
          const payload = await dispatcher.execute(
            call.operation,
            call.payload,
            "backend",
          );
          return hostResponse(() => payload);
        } catch (error) {
          return hostResponse(() => {
            throw error;
          });
        }
      },
      registry,
    );
    expect(await api.call(registry.operation("counter.increment"), 1)).toBe(12);
    expect([
      inputCalls,
      outputCalls,
      executions,
    ]).toEqual([
      1,
      1,
      1,
    ]);
    await expect(
      api.call(registry.operation("counter.increment"), "bad"),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(executions).toBe(1);
  } finally {
    await dispatcher.dispose();
  }
  expect(disposed).toBe(1);
});

test("UI adapters preserve this, cancellation context, lifecycle and safe parser failures", async () => {
  let received: unknown;
  let executions = 0;
  let disposed = 0;
  const raw: NativeAdapter = {
    execute() {
      throw new Error("UI path expected");
    },
    async executeUI(_name, input, _source, context) {
      expect(this).toBe(raw);
      received = context;
      executions++;
      return input;
    },
    busy() {
      expect(this).toBe(raw);
      return true;
    },
    dispose() {
      expect(this).toBe(raw);
      disposed++;
    },
  };
  const plugin = defineNativePlugin({
    name: "ui",
    operations: {
      echo: {
        input: z.string().trim(),
        output: z.string().transform((value) => `${value}!`),
      },
    },
    platforms: {
      windows: {
        thread: "ui",
        create: () => raw,
      },
    },
  });
  const adapter =
    plugin._definition.nativePlatforms.windows?.create(environment);
  if (!adapter?.executeUI) {
    throw new Error("Missing UI adapter");
  }
  const context = {
    requestId: "one",
    permissions: {
      permissions: [
        "ui.echo",
      ],
    },
    signal: new AbortController().signal,
  };
  expect(await adapter.executeUI("ui.echo", " ok ", "view", context)).toBe(
    "ok!",
  );
  expect(received).toBe(context);
  expect(adapter.busy?.()).toBe(true);
  await expect(
    adapter.executeUI("ui.echo", false, "view", context),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(executions).toBe(1);
  await adapter.dispose();
  expect(disposed).toBe(1);
  const invalid = defineNativePlugin({
    name: "bad",
    operations: {
      echo: {
        input: z.string(),
        output: z.string().refine(() => {
          throw new Error("secret native detail");
        }),
      },
    },
    platforms: {
      windows: {
        thread: "worker",
        create: () => ({
          execute: () => "ok",
          dispose() {},
        }),
      },
    },
  });
  const failed =
    invalid._definition.nativePlatforms.windows?.create(environment);
  await expect(failed?.execute("bad.echo", "ok", "view")).rejects.toThrow(
    expect.objectContaining({
      code: "INTERNAL",
      message: "Invalid plugin output.",
    }),
  );
});

test("JSON guards run before callbacks and validate transformed values before execution or reply", async () => {
  let callbacks = 0;
  const schema = z.unknown().transform((value) => {
    callbacks++;
    return value;
  });
  const parsers = pluginParsers("json", {
    echo: {
      input: schema,
      output: schema,
    },
  });
  let deep: JsonValue = null;
  for (let i = 0; i < MAX_JSON_DEPTH + 1; i++) {
    deep = {
      child: deep,
    };
  }
  const invalid: unknown[] = [
    Infinity,
    NaN,
    new Date(),
    {
      value: undefined,
    },
    {
      get value() {
        throw new Error("Getter executed");
      },
    },
    "x".repeat(MAX_MESSAGE_BYTES + 1),
    deep,
    "\ud800",
  ];
  for (const value of invalid) {
    await expect(parsers.validateOutput("json.echo", value)).rejects.toThrow();
  }
  expect(callbacks).toBe(0);
  for (const { schema, value } of [
    {
      schema: z.string().transform(() => new Date()),
      value: "ok",
    },
    {
      schema: z.number().transform(() => Infinity),
      value: 1,
    },
    {
      schema: z.null().transform(() => ({
        value: undefined,
      })),
      value: null,
    },
  ]) {
    const parsers = pluginParsers("bad", {
      echo: {
        input: schema,
        output: schema,
      },
    });
    await expect(parsers.validateOutput("bad.echo", value)).rejects.toThrow();
  }
  // A non-JSON transformation result must fail before the adapter is invoked.
  let executions = 0;
  const plugin = defineNativePlugin({
    name: "bad",
    operations: {
      echo: {
        input: z.string().transform(() => new Date()),
        output: z.null(),
      },
    },
    platforms: {
      windows: {
        thread: "worker",
        create: () => ({
          execute() {
            executions++;
            return null;
          },
          dispose() {},
        }),
      },
    },
  });
  await expect(
    plugin._definition.nativePlatforms.windows
      ?.create(environment)
      .execute("bad.echo", "ok", "view"),
  ).rejects.toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
  expect(executions).toBe(0);
});

test("plugin caller types follow original input and parsed output", () => {
  const plugin = defineNativePlugin({
    name: "typed",
    operations: {
      run: {
        input: z.object({
          name: z.string().default("guest"),
        }),
        output: z.number().transform((value) => String(value)),
      },
    },
  });
  expectTypeOf<Parameters<typeof plugin.run>[0]>().toEqualTypeOf<{
    name?: string | undefined;
  }>();
  expectTypeOf<
    Awaited<ReturnType<typeof plugin.run>>
  >().toEqualTypeOf<string>();
});

test("a real Worker loads parser code locally while messages contain only JSON", async () => {
  const worker = new Worker(
    new URL("../fixtures/zod-runtime-worker.ts", import.meta.url),
  );
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.postMessage({
        operation: "worker.increment",
        payload: 1,
      });
    });
    expect(result).toEqual({
      value: 12,
      inputCalls: 1,
      outputCalls: 1,
      registration: {
        operations: [
          {
            name: "worker.increment",
          },
        ],
      },
    });
    expect(() => validateValue({}, result)).not.toThrow();
  } finally {
    await worker.terminate();
  }
});

test("asynchronous refinements and transforms are awaited once at both boundaries", async () => {
  let inputCalls = 0;
  let outputCalls = 0;
  let executions = 0;
  const plugin = defineNativePlugin({
    name: "async",
    operations: {
      echo: {
        input: z
          .string()
          .refine(async (value) => {
            await Bun.sleep(1);
            return value !== "bad";
          })
          .transform(async (value) => {
            inputCalls++;
            await Bun.sleep(1);
            return value.trim();
          }),
        output: z.string().transform(async (value) => {
          outputCalls++;
          await Bun.sleep(1);
          return `${value}!`;
        }),
      },
    },
    platforms: {
      windows: {
        thread: "worker",
        create: () => ({
          execute(_name, input) {
            executions++;
            expect(input).toBe("ok");
            return input;
          },
          dispose() {},
        }),
      },
    },
  });
  const adapter =
    plugin._definition.nativePlatforms.windows?.create(environment);
  if (!adapter) {
    throw new Error("Missing adapter");
  }
  try {
    const execute = await adapter.prepare("async.echo", " ok ", "test");
    expect(executions).toBe(0);
    const result = execute();
    expect(executions).toBe(1); // Native execution starts synchronously after the host grants it.
    expect(await result).toBe("ok!");
    await expect(execute()).rejects.toThrow("already executed");
    await expect(
      adapter.execute("async.echo", "bad", "test"),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect([
      inputCalls,
      outputCalls,
      executions,
    ]).toEqual([
      1,
      1,
      1,
    ]);
  } finally {
    await adapter.dispose();
  }
});

test("failed asynchronous checks do not terminate the Worker or prevent its next request", async () => {
  await assertZodWorker(
    new URL("../fixtures/zod-async-worker.ts", import.meta.url),
  );
});

test("UI cancellation or disposal during input parsing prevents native execution", async () => {
  for (const cancel of [
    "signal",
    "dispose",
    "authority",
  ]) {
    const gate = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    let executions = 0;
    const plugin = defineNativePlugin({
      name: "cancel",
      operations: {
        run: {
          input: z.string().transform(() => {
            started.resolve();
            return gate.promise;
          }),
          output: z.string(),
        },
      },
      platforms: {
        windows: {
          thread: "ui",
          create: () => ({
            execute() {
              executions++;
              return "ok";
            },
            executeUI() {
              executions++;
              return "ok";
            },
            dispose() {},
          }),
        },
      },
    });
    const adapter =
      plugin._definition.nativePlatforms.windows?.create(environment);
    if (!adapter?.executeUI) {
      throw new Error("Missing adapter");
    }
    const controller = new AbortController();
    let revoked = false;
    const result = adapter.executeUI("cancel.run", "ok", "test", {
      requestId: "test",
      permissions: {
        permissions: [],
      },
      signal: controller.signal,
      beforeExecute() {
        if (revoked) {
          throw new Error("Revoked");
        }
      },
    });
    await started.promise;
    if (cancel === "signal") {
      controller.abort();
    } else if (cancel === "dispose") {
      await adapter.dispose();
    } else {
      revoked = true;
    }
    gate.resolve("ok");
    await expect(result).rejects.toThrow();
    expect(executions).toBe(0);
    if (cancel !== "dispose") {
      await adapter.dispose();
    }
  }
});

test("pinned Zod string limits count Unicode code points at both boundaries", async () => {
  const parsers = pluginParsers("unicode", {
    echo: {
      input: z.string().max(1),
      output: z.string().max(1),
    },
  });
  expect(
    (
      await parsers.validateCall({
        operation: "unicode.echo",
        payload: "😀",
      })
    ).payload,
  ).toBe("😀");
  expect(await parsers.validateOutput("unicode.echo", "😀")).toBe("😀");
  await expect(
    parsers.validateCall({
      operation: "unicode.echo",
      payload: "😀a",
    }),
  ).rejects.toThrow();
  await expect(parsers.validateOutput("unicode.echo", "😀a")).rejects.toThrow();
});

test("native declarations reject serialized schema objects instead of silently accepting unchecked values", () => {
  for (const schema of [
    {
      type: "string",
    },
    {
      $ref: "#/properties",
      properties: {
        type: {
          type: "number",
        },
      },
    },
  ]) {
    for (const operation of [
      {
        input: schema,
        output: z.string(),
      },
      {
        input: z.string(),
        output: schema,
      },
    ]) {
      expect(() =>
        Reflect.apply(defineNativePlugin, undefined, [
          {
            name: "invalid",
            operations: {
              read: operation,
            },
          },
        ]),
      ).toThrow("Plugin inputs and outputs must be Zod schemas.");
    }
  }
});
