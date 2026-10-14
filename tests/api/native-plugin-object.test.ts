import { expect, expectTypeOf, test } from "bun:test";
import { defineApp, type EventsOf } from "@bunaway/backend";
import { defineNativePlugin } from "@bunaway/plugin";
import appearance from "@bunaway/plugin-appearance";
import capabilities from "@bunaway/plugin-capabilities";
import { z } from "zod";

const events = {
  "example.changed": {
    type: "string",
  },
} as const;
const read = {
  input: z.null(),
  output: z.string(),
  handler: () => "value",
};

test("one plugin object composes with ordinary plugins and retains event inference", () => {
  let initialized = 0;
  const plugin = defineNativePlugin({
    name: "example",
    events,
    platforms: {
      windows: {
        initialize() {
          initialized++;
        },
        operations: {
          read,
          name: read,
        },
      },
    },
  });
  const ordinary = {
    name: "ordinary",
    version: "1",
  };
  const app = defineApp({
    modules: [],
    plugins: [
      plugin,
      ordinary,
    ],
  });
  const again = defineApp({
    modules: [],
    plugins: [
      plugin,
    ],
  });
  expectTypeOf<
    EventsOf<typeof app>["example.changed"]
  >().toEqualTypeOf<string>();
  expectTypeOf<ReturnType<typeof plugin.read>>().toEqualTypeOf<
    Promise<string>
  >();
  expect(app.plugins?.[0]).toBe(plugin._definition);
  expect(again.plugins?.[0]).toBe(app.plugins?.[0]);
  expect(app.plugins?.[1]).toBe(ordinary);
  expect(initialized).toBe(0);
  expect(typeof plugin.name).toBe("function");
  expect(plugin._definition.name).toBe("example");
  expect(Object.keys(plugin)).toEqual([
    "read",
    "name",
  ]);
  expect(Object.getOwnPropertyDescriptor(plugin, "_definition")).toMatchObject({
    enumerable: false,
    writable: false,
    configurable: false,
  });
  expect(Object.isFrozen(plugin)).toBe(true);
  expect(Object.isFrozen(plugin._definition)).toBe(true);
  expect(JSON.stringify(plugin)).toBe("{}");
});

test("official default exports are callable and registrable APIs", () => {
  const app = defineApp({
    modules: [],
    plugins: [
      appearance,
      capabilities,
    ],
  });
  expect(typeof appearance.getPreferences).toBe("function");
  expect(typeof capabilities).toBe("function");
  expect(app.plugins?.map((plugin) => plugin.name)).toEqual([
    "appearance",
    "capabilities",
  ]);
});

test("custom calls retain their signatures and use the same generated transport", async () => {
  const plugin = defineNativePlugin(
    {
      name: "example",
      platforms: {
        windows: {
          operations: {
            read,
          },
        },
      },
    },
    (api) => ({
      getValue: () => api.read(null),
    }),
  );
  expectTypeOf<Parameters<typeof plugin.getValue>>().toEqualTypeOf<[]>();
  expectTypeOf<ReturnType<typeof plugin.getValue>>().toEqualTypeOf<
    Promise<string>
  >();
  expect(
    defineApp({
      modules: [],
      plugins: [
        plugin,
      ],
    }).plugins?.[0],
  ).toBe(plugin._definition);
  // Backend calls still require a live command/setup scope, even through custom calls.
  await expect(plugin.getValue()).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});

test.each([
  "_definition",
  "then",
  "toJSON",
])(
  "reserved API name %s cannot replace metadata or become a Promise/JSON hook",
  (name) => {
    expect(() =>
      defineNativePlugin({
        name: "example",
        platforms: {
          windows: {
            operations: {
              [name]: read,
            },
          },
        },
      }),
    ).toThrow("Reserved native plugin operation name");
    expect(() =>
      defineNativePlugin(
        {
          name: "example",
          platforms: {
            windows: {
              operations: {
                read,
              },
            },
          },
        },
        () => ({
          [name]: () => null,
        }),
      ),
    ).toThrow("reserved properties");
  },
);
