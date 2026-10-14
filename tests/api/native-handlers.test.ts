import { expect, test } from "bun:test";
import {
  defineNativeAdapter,
  defineNativePlugin,
  type NativeEnvironment,
} from "@bunaway/plugin";
import { z } from "zod";
import { operations } from "#native/host-api/bun/plugins";

const schemas = {
  length: {
    input: z.string().transform((value) => value.length),
    output: z.number(),
  },
  missing: {
    input: z.null(),
    output: z.null(),
  },
};
const environment = {
  dataRoot: ".",
  capabilities: [],
};
const context = {
  requestId: "test",
  permissions: {
    permissions: [
      "demo.length",
      "demo.missing",
    ],
  },
};

test("handler keys infer immutable support and typed parsing without dispatch switches", async () => {
  const calls: number[] = [];
  const handlers = {
    length(input: number) {
      calls.push(input);
      return input;
    },
  };
  const factory = defineNativeAdapter(schemas, {
    setup: () => null,
    handlers,
    dispose() {},
  });
  const plugin = defineNativePlugin({
    name: "demo",
    operations: schemas,
    platforms: {
      windows: {
        thread: "worker",
        create: factory,
      },
    },
    events: {
      "demo.changed": {
        type: "integer",
      },
    },
  });
  expect(() =>
    defineNativePlugin({
      name: "demo",
      operations: schemas,
      platforms: {
        windows: {
          thread: "worker",
          create: factory,
          operations: [
            "length",
          ],
        },
      },
    }),
  ).toThrow("omit the platform operations list");
  expect(factory.operations).toEqual([
    "length",
  ]);
  expect(Object.isFrozen(factory.operations)).toBe(true);
  expect(plugin._definition.nativePlatforms.windows?.operations).toEqual([
    "length",
  ]);
  const adapter =
    plugin._definition.nativePlatforms.windows?.create(environment);
  if (!adapter?.executeUI) {
    throw new Error("Missing mapped adapter");
  }
  expect(
    await adapter.executeUI("demo.length", "hello", "backend", context),
  ).toBe(5);
  expect(calls).toEqual([
    5,
  ]);
  await expect(
    adapter.executeUI("demo.missing", null, "backend", context),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  await expect(
    adapter.executeUI("demo.length", "hello", "backend", {
      ...context,
      permissions: {
        permissions: [],
      },
    }),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  expect(calls).toEqual([
    5,
  ]);
  await adapter.dispose();
  await expect(
    adapter.executeUI("demo.length", "hello", "backend", context),
  ).rejects.toMatchObject({
    code: "CANCELLED",
  });
});

test("contextual preparation parses once and rechecks cancellation and authority immediately before entry", async () => {
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let parses = 0;
  let executions = 0;
  const operations = {
    run: {
      input: z.string().transform(async (input) => {
        parses++;
        await gate;
        return input.length;
      }),
      output: z.number(),
    },
  };
  const factory = defineNativeAdapter(operations, {
    setup: () => null,
    handlers: {
      run(input) {
        executions++;
        return input;
      },
    },
    dispose() {},
  });
  const plugin = defineNativePlugin({
    name: "demo",
    operations,
    platforms: {
      windows: {
        thread: "worker",
        create: factory,
      },
    },
  });
  const adapter =
    plugin._definition.nativePlatforms.windows?.create(environment);
  if (!adapter) {
    throw new Error("Missing adapter");
  }
  const controller = new AbortController();
  const preparing = adapter.prepare("demo.run", "hello", "backend", {
    ...context,
    permissions: {
      permissions: [
        "demo.run",
      ],
    },
    signal: controller.signal,
  });
  controller.abort();
  release();
  const execute = await preparing;
  await expect(execute()).rejects.toMatchObject({
    code: "CANCELLED",
  });
  expect(parses).toBe(1);
  expect(executions).toBe(0);
  const revoked = await adapter.prepare("demo.run", "hello", "backend", {
    ...context,
    permissions: {
      permissions: [
        "demo.run",
      ],
    },
    beforeExecute() {
      throw new Error("revoked");
    },
  });
  await expect(revoked()).rejects.toThrow("revoked");
  expect(executions).toBe(0);
  await adapter.dispose();
});

test("mapped adapters clean earlier resources after later setup fails", async () => {
  const cleanup: string[] = [];
  const plugins = [
    "first",
    "second",
    "failure",
  ].map((name) => {
    const create = defineNativeAdapter(
      {
        run: {
          input: z.null(),
          output: z.null(),
        },
      },
      {
        setup() {
          if (name === "failure") {
            throw new Error("setup failed");
          }
          return name;
        },
        handlers: {
          run: () => null,
        },
        dispose(state) {
          cleanup.push(state);
        },
      },
    );
    return defineNativePlugin({
      name,
      operations: {
        run: {
          input: z.null(),
          output: z.null(),
        },
      },
      platforms: {
        windows: {
          thread: "ui",
          create,
        },
      },
    })._definition;
  });
  const catalog = plugins.map((plugin) => ({
    name: plugin.name,
    version: plugin.version,
    native: plugin.native,
    thread: "ui" as const,
    supportedOperations: [
      `${plugin.name}.run`,
    ],
    operations: async () => ({
      createOperations(environment: NativeEnvironment) {
        const target = plugin.nativePlatforms.windows;
        if (!target) {
          throw new Error("Missing target");
        }
        return target.create(environment);
      },
    }),
  }));
  await expect(
    operations(plugins, ".", "ui", undefined, catalog),
  ).rejects.toThrow("setup failed");
  expect(cleanup).toEqual([
    "second",
    "first",
  ]);
});
