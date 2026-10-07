import { afterEach, expect, test } from "bun:test";
import { type PackagedPlugin, packagedPlugins } from "../../native/windows/bun/plugin-table.ts";
import {
  disposeAll,
  operations,
  permissionMatcher,
  pluginRegistry,
} from "../../native/windows/bun/plugins.ts";

const table = packagedPlugins as PackagedPlugin[];
afterEach(() => {
  table.length = 0;
});
const native = { operations: [], permissions: [] } as const;

test("installed contracts compare by content while changes still fail startup", () => {
  table.push({ name: "test", version: "1", native });
  expect(() =>
    pluginRegistry([{ name: "test", version: "1", native: { permissions: [], operations: [] } }]),
  ).not.toThrow();
  expect(() => pluginRegistry([{ name: "test", version: "2", native }])).toThrow();
  expect(() =>
    pluginRegistry([
      {
        name: "test",
        version: "1",
        native: { operations: [], permissions: [{ name: "test:read" }] },
      },
    ]),
  ).toThrow();
});

test("shutdown and initialization failure clean every prepared adapter in reverse order", async () => {
  const cleaned: string[] = [];
  const failure = new Error("cleanup failed");
  for (const name of ["first", "second"])
    table.push({
      name,
      version: "1",
      native,
      execution: "io",
      operations: async () => ({
        createOperations: () => ({
          execute: () => null,
          dispose() {
            cleaned.push(name);
            if (name === "second") throw failure;
          },
        }),
      }),
    });
  const registrations = () => table.map(({ name, version, native }) => ({ name, version, native }));
  const adapters = await operations(registrations(), ".", "io");
  await expect(adapters.dispose()).rejects.toBeInstanceOf(AggregateError);
  expect(cleaned).toEqual(["second", "first"]);
  cleaned.length = 0;
  const initialization = new Error("initialization failed");
  table.push({
    name: "third",
    version: "1",
    native,
    execution: "io",
    operations: async () => {
      throw initialization;
    },
  });
  try {
    await operations(registrations(), ".", "io");
    throw new Error("Initialization unexpectedly succeeded.");
  } catch (error) {
    expect((error as AggregateError).errors[0]).toBe(initialization);
  }
  expect(cleaned).toEqual(["second", "first"]);
  cleaned.length = 0;
  await expect(
    disposeAll([
      () => adapters.dispose(),
      () => {
        cleaned.push("windows");
      },
    ]),
  ).rejects.toBeInstanceOf(AggregateError);
  expect(cleaned).toEqual(["second", "first", "windows"]);
});

test("scopeless and unregistered plugins do not load authorization modules", async () => {
  let loaded = 0;
  table.push({
    name: "test",
    version: "1",
    native,
    authorization: async () => {
      loaded++;
      return { matches: () => true };
    },
  });
  const matches = await permissionMatcher([{ name: "test", version: "1", native }]);
  expect(loaded).toBe(0);
  expect(matches("test:read", null, null)).toBe(false);
  const plugin = table[0];
  if (!plugin) throw new Error("Missing test plugin.");
  plugin.native = {
    operations: [],
    permissions: [{ name: "test:read", scope: { type: "string" } }],
  };
  await permissionMatcher([]);
  expect(loaded).toBe(0);
  await permissionMatcher([{ name: "test", version: "1", native: plugin.native }]);
  expect(loaded).toBe(1);
});
