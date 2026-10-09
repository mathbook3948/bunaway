import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { Channel, type UIConfig } from "../../native/windows/bun/channel.ts";
import type { PackagedPlugin } from "../../native/windows/bun/plugin-contract.ts";
import {
  disposeAll,
  operations,
  permissionMatcher,
  pluginRegistry,
} from "../../native/windows/bun/plugins.ts";
import {
  defineNativePlugin,
  type NativeEnvironment,
  s,
} from "../../packages/plugin-sdk/src/index.ts";
import { validateValue } from "../../packages/protocol/src/index.ts";
import { capabilitiesPlugin } from "../../plugins/capabilities/src/index.ts";
import { createOperations as createCapabilities } from "../../plugins/capabilities/src/windows.ts";
import { bundleUIPluginFixture } from "../fixtures/native-worker.ts";

const native = {
  operations: [],
  permissions: [],
} as const;

test("installed contracts compare by content while changes still fail startup", () => {
  const catalog: PackagedPlugin[] = [
    {
      name: "test",
      version: "1",
      native,
    },
  ];
  expect(() =>
    pluginRegistry(
      [
        {
          name: "test",
          version: "1",
          native: {
            permissions: [],
            operations: [],
          },
        },
      ],
      catalog,
    ),
  ).not.toThrow();
  expect(() =>
    pluginRegistry(
      [
        {
          name: "test",
          version: "2",
          native,
        },
      ],
      catalog,
    ),
  ).toThrow();
  expect(() =>
    pluginRegistry(
      [
        {
          name: "test",
          version: "1",
          native: {
            operations: [],
            permissions: [
              {
                name: "test:read",
              },
            ],
          },
        },
      ],
      catalog,
    ),
  ).toThrow();
});

test("installed contracts accept validated JSON snapshots without hiding schema changes", () => {
  const schema = validateValue(
    s.object({
      type: s.enum([
        "string",
      ]),
    }),
    {
      type: "string",
    },
  );
  const plugin = defineNativePlugin({
    name: "example",
    version: "1",
    operations: {
      echo: {
        input: schema,
        output: schema,
        permission: "echo",
      },
    },
    scopes: {
      echo: schema,
    },
    matches: (_permission, input, scope) => input === scope,
  }).definition;
  const packaged = JSON.parse(JSON.stringify(plugin.native));
  const installed = {
    name: plugin.name,
    version: plugin.version,
    native: packaged,
  };
  const catalog: PackagedPlugin[] = [
    installed,
  ];
  expect(Object.getPrototypeOf(schema)).toBeNull();
  expect(() =>
    pluginRegistry(
      [
        plugin,
      ],
      catalog,
    ),
  ).not.toThrow();
  installed.native = plugin.native;
  expect(() =>
    pluginRegistry(
      [
        {
          ...plugin,
          native: packaged,
        },
      ],
      catalog,
    ),
  ).not.toThrow();
  packaged.operations[0].input.type = "integer";
  expect(() =>
    pluginRegistry(
      [
        {
          ...plugin,
          native: packaged,
        },
      ],
      catalog,
    ),
  ).toThrow();
});

test("installed contracts normalize negative zero without hiding numeric changes", () => {
  const plugin = defineNativePlugin({
    name: "zero",
    version: "1",
    operations: {
      echo: {
        input: s.integer({
          minimum: -0,
        }),
        output: {
          const: -0,
        },
        permission: "echo",
      },
    },
    scopes: {
      echo: s.integer({
        minimum: -0,
      }),
    },
    matches: (_permission, input, scope) => input === scope,
  }).definition;
  const installed = {
    ...plugin,
    native: JSON.parse(JSON.stringify(plugin.native)),
  };
  const catalog: PackagedPlugin[] = [
    installed,
  ];
  expect(Object.is(plugin.native.operations[0]?.input.minimum, -0)).toBe(true);
  expect(() =>
    pluginRegistry(
      [
        plugin,
      ],
      catalog,
    ),
  ).not.toThrow();
  installed.native.operations[0].input.minimum = 1;
  expect(() =>
    pluginRegistry(
      [
        plugin,
      ],
      catalog,
    ),
  ).toThrow("does not match");
});
test("shutdown and initialization failure clean every prepared adapter in reverse order", async () => {
  const catalog: PackagedPlugin[] = [];
  const cleaned: string[] = [];
  const failure = new Error("cleanup failed");
  for (const name of [
    "first",
    "second",
  ]) {
    catalog.push({
      name,
      version: "1",
      native,
      execution: "io",
      operations: async () => ({
        createOperations: () => ({
          execute: () => null,
          dispose() {
            cleaned.push(name);
            if (name === "second") {
              throw failure;
            }
          },
        }),
      }),
    });
  }
  const registrations = () =>
    catalog.map(({ name, version, native }) => ({
      name,
      version,
      native,
    }));
  // The second disposer throws, so cleanup must still reach the first adapter.
  const adapters = await operations(
    registrations(),
    ".",
    "io",
    undefined,
    catalog,
  );
  await expect(adapters.dispose()).rejects.toBeInstanceOf(AggregateError);
  expect(cleaned).toEqual([
    "second",
    "first",
  ]);
  cleaned.length = 0;
  const initialization = new Error("initialization failed");
  catalog.push({
    name: "third",
    version: "1",
    native,
    execution: "io",
    operations: async () => {
      throw initialization;
    },
  });
  try {
    await operations(registrations(), ".", "io", undefined, catalog);
    throw new Error("Initialization unexpectedly succeeded.");
  } catch (error) {
    expect((error as AggregateError).errors[0]).toBe(initialization);
  }
  expect(cleaned).toEqual([
    "second",
    "first",
  ]);
  cleaned.length = 0;
  await expect(
    disposeAll([
      () => adapters.dispose(),
      () => {
        cleaned.push("windows");
      },
    ]),
  ).rejects.toBeInstanceOf(AggregateError);
  expect(cleaned).toEqual([
    "second",
    "first",
    "windows",
  ]);
});

test("scopeless and unregistered plugins do not load authorization modules", async () => {
  const catalog: PackagedPlugin[] = [];
  let loaded = 0;
  catalog.push({
    name: "test",
    version: "1",
    native,
    authorization: async () => {
      loaded++;
      return {
        matches: () => true,
      };
    },
  });
  const matches = await permissionMatcher(
    [
      {
        name: "test",
        version: "1",
        native,
      },
    ],
    catalog,
  );
  expect(loaded).toBe(0);
  expect(matches("test:read", null, null)).toBe(false);
  const plugin = catalog[0];
  if (!plugin) {
    throw new Error("Missing test plugin.");
  }
  plugin.native = {
    operations: [],
    permissions: [
      {
        name: "test:read",
        scope: {
          type: "string",
        },
      },
    ],
  };
  await permissionMatcher([], catalog);
  expect(loaded).toBe(0);
  await permissionMatcher(
    [
      {
        name: "test",
        version: "1",
        native: plugin.native,
      },
    ],
    catalog,
  );
  expect(loaded).toBe(1);
});

test("capability permission metadata comes from each registered operation contract", async () => {
  const catalog: PackagedPlugin[] = [];
  const storage = {
    name: "storage",
    version: "1",
    native: {
      operations: [
        {
          name: "storage.read",
          input: {
            const: null,
          },
          output: {
            const: null,
          },
          permission: "storage:read",
        },
      ],
      permissions: [
        {
          name: "storage:read",
        },
      ],
    },
  } as const;
  const files = {
    name: "files",
    version: "1",
    native: {
      operations: [
        {
          name: "files.read",
          input: {
            const: null,
          },
          output: {
            const: null,
          },
          permission: "files:read",
          osPermission: "not-required",
        },
      ],
      permissions: [
        {
          name: "files:read",
        },
      ],
    },
  } as const;
  let observed: NativeEnvironment | undefined;
  for (const plugin of [
    storage,
    files,
  ]) {
    catalog.push({
      ...plugin,
      execution: "io",
      operations: async () => ({
        createOperations(environment) {
          observed = environment;
          return {
            execute: () => null,
            dispose() {},
          };
        },
      }),
    });
  }
  const registrations = [
    storage,
    files,
  ];
  const adapters = await operations(
    registrations,
    ".",
    "io",
    undefined,
    catalog,
  );
  try {
    if (!observed) {
      throw new Error("Plugin did not receive capability metadata.");
    }
    expect(observed.capabilities).toHaveLength(2);
    expect(observed.capabilities).toEqual([
      {
        name: "storage.read",
        support: "supported",
        permission: "unknown",
      },
      {
        name: "files.read",
        support: "supported",
        permission: "not-required",
      },
    ]);
    expect(
      createCapabilities(observed).execute("capabilities.get", null, "backend"),
    ).toEqual(observed.capabilities);
  } finally {
    await adapters.dispose();
  }
});

test("capability queries include every operation at the native registry limit", async () => {
  const catalog: PackagedPlugin[] = [];
  const plugin = {
    name: "catalog",
    version: "1",
    native: {
      // Leave the final registry slot for the built-in capabilities operation.
      operations: Array.from(
        {
          length: 255,
        },
        (_, index) => ({
          name: `catalog.call${index}`,
          input: {
            const: null,
          },
          output: {
            const: null,
          },
          permission: "catalog:call",
        }),
      ),
      permissions: [
        {
          name: "catalog:call",
        },
      ],
    },
  } as const;
  catalog.push(plugin, {
    ...capabilitiesPlugin,
    execution: "io",
    operations: async () => ({
      createOperations: createCapabilities,
    }),
  });
  const registry = pluginRegistry(
    [
      plugin,
      capabilitiesPlugin,
    ],
    catalog,
  );
  expect(registry.operations.size).toBe(256);
  const adapters = await operations(
    [
      plugin,
      capabilitiesPlugin,
    ],
    ".",
    "io",
    undefined,
    catalog,
  );
  try {
    const result = adapters.execute("capabilities.get", null, "backend");
    expect(result).toHaveLength(256);
    expect(
      (
        result as {
          name: string;
        }[]
      ).map(({ name }) => name),
    ).toEqual([
      ...registry.operations.keys(),
    ]);
  } finally {
    await adapters.dispose();
  }
});

test.skipIf(process.platform !== "win32")(
  "UI adapters initialize and dispose inside the UI Worker's COM apartment",
  async () => {
    const dataRoot = resolve(
      import.meta.dir,
      `../../build/windows-ui-plugin-${crypto.randomUUID()}`,
    );
    await mkdir(dataRoot, {
      recursive: true,
    });
    await bundleUIPluginFixture(
      dataRoot,
      [
        {
          name: "sta-test",
          version: "1",
          native: native,
          execution: "ui",
          authorization: false,
        },
      ],
      `import assert from "node:assert/strict";
import { dlopen, ptr } from "bun:ffi";
import { writeFileSync } from "node:fs";
const ole = dlopen("ole32.dll", {
  CoGetApartmentType: { args: ["ptr", "ptr"], returns: "i32" },
});
function checkApartment() {
  const type = new Uint32Array(1);
  const qualifier = new Uint32Array(1);
  assert.equal(ole.symbols.CoGetApartmentType(ptr(type), ptr(qualifier)), 0);
  assert([0, 3].includes(type[0]), "UI adapter must run in STA");
}
export const pluginImports = { 'sta-test': {
  operations: async () => ({ createOperations() {
    checkApartment();
    return { execute: () => null, dispose() {
      checkApartment();
      writeFileSync(${JSON.stringify(resolve(dataRoot, "disposed.txt"))}, "STA");
      ole.close();
    } };
  } }),
}};
`,
    );
    const config: UIConfig = {
      runtime: {
        id: "sta-test",
        generation: "1",
      },
      policy: {
        version: 1,
        views: [],
        backend: {
          permissions: [],
        },
      },
      backendContext: "backend" as UIConfig["backendContext"],
      windows: [],
      assets: dataRoot,
      dataRoot,
      loader: "",
      plugins: [
        {
          name: "sta-test",
          version: "1",
          native,
        },
      ],
    };
    const worker = new Worker(pathToFileURL(resolve(dataRoot, "ui.js")), {
      workerData: config,
    });
    const exited = new Promise<number>((resolve) =>
      worker.once("exit", resolve),
    );
    let failure: unknown;
    let ready = false;
    let cleaned = false;
    worker.once("error", (error) => {
      failure = error;
    });
    const channel = new Channel(
      worker,
      config.runtime,
      "main",
      (packet) => {
        if (packet.kind === "ready") {
          ready = true;
          channel.notify({
            kind: "shutdown",
          });
        } else if (packet.kind === "cleaned") {
          cleaned = true;
        } else if (packet.kind === "fatal") {
          failure = new Error(packet.error.message);
        }
      },
      (error) => {
        failure = error;
        void worker.terminate();
      },
    );
    const timer = setTimeout(() => {
      failure = new Error("UI plugin worker timed out");
      void worker.terminate();
    }, 5000);
    try {
      expect(await exited).toBe(0);
      expect(failure).toBeUndefined();
      expect(ready).toBe(true);
      expect(cleaned).toBe(true);
      expect(await Bun.file(resolve(dataRoot, "disposed.txt")).text()).toBe(
        "STA",
      );
    } finally {
      clearTimeout(timer);
      channel.close();
      await worker.terminate();
    }
  },
);
