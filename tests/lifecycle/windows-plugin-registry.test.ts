import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { defineNativePlugin, type NativeEnvironment } from "@bunaway/plugin";
import capabilities from "@bunaway/plugin-capabilities";
import { validateValue } from "@bunaway/protocol";
import { z } from "zod";
import type { PackagedPlugin } from "#native/host-api/bun/plugin-contract";
import {
  disposeAll,
  operations,
  pluginRegistry,
} from "#native/host-api/bun/plugins";
import { Channel, type UIConfig } from "#native/windows/bun/channel";
import capabilitiesDefinition from "#plugins/capabilities/src/index";
import { testAppMetadata } from "../fixtures/app-info.ts";
import { nativeFactory } from "../fixtures/native-platform.ts";

import { bundleUIPluginFixture } from "../fixtures/native-worker.ts";

const createCapabilities = nativeFactory(capabilitiesDefinition, "windows");

const native = {
  operations: [],
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
            operations: [
              {
                name: "test.read",
              },
            ],
          },
        },
      ],
      catalog,
    ),
  ).toThrow();
});
test("installed operation metadata accepts JSON snapshots and rejects changed names", () => {
  const plugin = defineNativePlugin({
    name: "example",
    operations: {
      echo: {
        input: z.string(),
        output: z.string(),
      },
    },
  })._definition;
  const detached = validateValue({}, plugin.native);
  const packaged = JSON.parse(JSON.stringify(plugin.native));
  const catalog: PackagedPlugin[] = [
    {
      name: plugin.name,
      version: plugin.version,
      native: packaged,
    },
  ];
  expect(Object.getPrototypeOf(detached)).toBeNull();
  expect(() =>
    pluginRegistry(
      [
        plugin,
      ],
      catalog,
    ),
  ).not.toThrow();
  packaged.operations[0].name = "example.other";
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
      thread: "worker",
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
    "worker",
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
    thread: "worker",
    operations: async () => {
      throw initialization;
    },
  });
  try {
    await operations(registrations(), ".", "worker", undefined, catalog);
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
test("unregistered native adapters are not imported or initialized", async () => {
  const native = {
    operations: [
      {
        name: "test.read",
      },
    ],
  };
  let imported = 0;
  let disposed = 0;
  const catalog: PackagedPlugin[] = [
    {
      name: "test",
      version: "1",
      native,
      thread: "worker",
      operations: async () => {
        imported++;
        return {
          createOperations: () => ({
            execute: () => null,
            dispose() {
              disposed++;
            },
          }),
        };
      },
    },
  ];
  const inactive = await operations([], ".", "worker", undefined, catalog);
  expect(imported).toBe(0);
  await expect(inactive.execute("test.read", null, "backend")).rejects.toThrow(
    expect.objectContaining({
      code: "UNSUPPORTED",
    }),
  );
  await inactive.dispose();
  const active = await operations(
    [
      {
        name: "test",
        version: "1",
        native,
      },
    ],
    ".",
    "worker",
    undefined,
    catalog,
  );
  expect(imported).toBe(1);
  expect(await active.execute("test.read", null, "backend")).toBeNull();
  await active.dispose();
  expect(disposed).toBe(1);
});
test("capabilities report platform support without claiming OS consent", async () => {
  const catalog: PackagedPlugin[] = [];
  const storage = {
    name: "storage",
    version: "1",
    native: {
      operations: [
        {
          name: "storage.read",
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
      thread: "worker",
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
    "worker",
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
      },
      {
        name: "files.read",
        support: "supported",
      },
    ]);
    expect(
      await createCapabilities(observed).execute(
        "capabilities.get",
        null,
        "backend",
      ),
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
        }),
      ),
    },
  } as const;
  catalog.push(plugin, {
    ...capabilities._definition,
    thread: "worker",
    operations: async () => ({
      createOperations: createCapabilities,
    }),
  });
  const registry = pluginRegistry(
    [
      plugin,
      capabilities._definition,
    ],
    catalog,
  );
  expect(registry.operations.size).toBe(256);
  const adapters = await operations(
    [
      plugin,
      capabilities._definition,
    ],
    ".",
    "worker",
    undefined,
    catalog,
  );
  try {
    const result = await adapters.execute("capabilities.get", null, "backend");
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
          thread: "ui",
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
      appMetadata: testAppMetadata,
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
