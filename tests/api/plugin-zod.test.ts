import { expect, expectTypeOf, test } from "bun:test";
import { defineNativePlugin } from "@bunaway/plugin";
import {
  type Infer,
  MAX_JSON_DEPTH,
  MAX_MESSAGE_BYTES,
  NativeRegistry,
  toJSONSchema,
  validateValue,
} from "@bunaway/protocol";
import { z } from "zod";
import { parse, serialize } from "../../packages/protocol/src/validation.ts";

test("serialized and source schemas preserve concrete input and output types", () => {
  const schema = z.strictObject({
    name: z.string(),
    details: z.json().exactOptional(),
  });
  const serialized = toJSONSchema(schema);
  expectTypeOf<Infer<typeof serialized>>().toEqualTypeOf<
    z.output<typeof schema>
  >();
  expectTypeOf<
    Infer<{
      type: "number";
    }>
  >().toEqualTypeOf<number>();
  expectTypeOf<
    Infer<{
      type: "null";
    }>
  >().toEqualTypeOf<null>();
  expectTypeOf<
    Infer<{
      type: readonly [
        "string",
        "null",
      ];
    }>
  >().toEqualTypeOf<string | null>();
});

test("Zod declarations and serialized native contracts accept the same JSON values", () => {
  const cases = [
    {
      schema: z.string().min(1).max(1),
      values: [
        "😀",
        "",
        "😀😀",
      ],
    },
    {
      schema: z.number().gt(0).lte(1).multipleOf(0.1),
      values: [
        0.3,
        0,
        1.1,
        0.35,
      ],
    },
    {
      schema: z.int(),
      values: [
        0,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER + 1,
        0.5,
      ],
    },
    {
      schema: z.literal([
        1,
        true,
        null,
      ]),
      values: [
        1,
        true,
        null,
        2,
        false,
      ],
    },
    {
      schema: z.string().nullable(),
      values: [
        "ok",
        null,
        1,
      ],
    },
    {
      schema: z.array(z.string().nullable()).max(2),
      values: [
        [],
        [
          null,
          "ok",
        ],
        [
          1,
        ],
        [
          "a",
          "b",
          "c",
        ],
      ],
    },
    {
      schema: z.strictObject({
        name: z.string(),
        details: z.json().exactOptional(),
      }),
      values: [
        {
          name: "ok",
        },
        {
          name: "ok",
          details: {
            nested: [
              null,
              1,
              true,
            ],
          },
        },
        {},
        {
          name: "ok",
          extra: true,
        },
      ],
    },
    {
      schema: z.object({
        name: z.string(),
      }),
      values: [
        {
          name: "ok",
          extra: true,
        },
        {},
        {
          name: 1,
        },
      ],
    },
    {
      schema: z.object({}),
      values: [
        {
          extra: true,
        },
        {},
      ],
    },
    {
      schema: z.object({
        children: z.array(
          z.object({
            name: z.string(),
          }),
        ),
      }),
      values: [
        {
          children: [
            {
              name: "ok",
              extra: true,
            },
          ],
          extra: true,
        },
      ],
    },
    {
      schema: z.union([
        z.object({
          nested: z.object({
            name: z.string(),
          }),
          kind: z.literal("first"),
        }),
        z.strictObject({
          nested: z.strictObject({
            name: z.string(),
            extra: z.boolean(),
          }),
          kind: z.literal("second"),
        }),
      ]),
      values: [
        {
          nested: {
            name: "ok",
            extra: true,
          },
          kind: "second",
        },
      ],
    },
    {
      schema: z.union([
        z.object({
          name: z.string(),
        }),
        z.object({
          extra: z.boolean(),
        }),
      ]),
      values: [
        {
          name: "ok",
          extra: true,
        },
      ],
    },
    {
      schema: z.record(z.string(), z.int()),
      values: [
        {
          a: 1,
        },
        {
          a: "bad",
        },
      ],
    },
    {
      schema: z.json(),
      values: [
        null,
        true,
        1,
        "ok",
        [
          {
            nested: [
              null,
              1,
              true,
            ],
          },
        ],
      ],
    },
  ];
  for (const { schema, values } of cases) {
    const plugin = defineNativePlugin({
      name: "test",
      operations: {
        echo: {
          input: schema,
          output: schema,
        },
      },
    });
    const registry = new NativeRegistry([
      JSON.parse(JSON.stringify(plugin.definition)),
    ]);
    for (const value of values) {
      const parsed = schema.safeParse(value);
      if (parsed.success) {
        expect(
          registry.validateCall({
            operation: "test.echo",
            payload: value,
          }).payload,
        ).toEqual(parsed.data);
        expect(registry.validateOutput("test.echo", value)).toEqual(
          parsed.data,
        );
        expect(validateValue(schema, value)).toEqual(parsed.data);
      } else {
        expect(() =>
          registry.validateCall({
            operation: "test.echo",
            payload: value,
          }),
        ).toThrow();
        expect(() => registry.validateOutput("test.echo", value)).toThrow();
      }
    }
  }
});

test("shared plugin declarations reject lost checks and value transformations", () => {
  for (const schema of [
    z.string().transform((value) => value.length),
    z
      .string()
      .transform((value) => value.length)
      .pipe(z.number()),
    z.string().refine((value) => value === "secret"),
    z.strictObject({
      name: z.string().refine((value) => value !== "bad"),
    }),
    z.string().trim(),
    z.coerce.number(),
    z.string().default("default"),
    z.string().optional(),
    z.string().exactOptional(),
    z.date(),
    z.bigint(),
    z.string().regex(/^.$/),
    z.string().regex(/^a$/iu),
    z.string().regex(/^a$/u).regex(/^b$/u),
  ]) {
    expect(() =>
      defineNativePlugin({
        name: "invalid",
        operations: {
          run: {
            input: schema,
            output: z.null(),
          },
        },
      }),
    ).toThrow();
  }
  expect(() =>
    Reflect.apply(defineNativePlugin, undefined, [
      {
        name: "old",
        operations: {
          run: {
            input: {
              const: null,
            },
            output: {
              const: null,
            },
          },
        },
      },
    ]),
  ).toThrow();
});

test("numeric record key declarations fail before a lossy contract can be registered", () => {
  for (const key of [
    z.number(),
    z.int().min(5),
    z.number().gt(0).max(10).multipleOf(0.5),
    z.union([
      z.string(),
      z.int().min(5),
    ]),
    z.intersection(z.number(), z.number().min(5)),
    z.lazy(() => z.int().min(5)),
    z.int().exactOptional(),
    z.int().nonoptional(),
  ]) {
    const schema = z.record(key, z.string());
    for (const operation of [
      {
        input: schema,
        output: z.null(),
      },
      {
        input: z.null(),
        output: schema,
      },
    ]) {
      expect(() =>
        defineNativePlugin({
          name: "invalid",
          operations: {
            echo: operation,
          },
        }),
      ).toThrow("Plugin record keys cannot use numeric schemas.");
    }
  }
  const shared = z.int().min(5);
  expect(() =>
    toJSONSchema(
      z.strictObject({
        id: shared,
        values: z.record(shared, z.string()),
      }),
    ),
  ).toThrow("Plugin record keys cannot use numeric schemas.");
});

test("exhaustive record keys remain required while partial records permit omissions", () => {
  for (const keys of [
    z.enum([
      "a",
      "b",
    ]),
    z.union([
      z.literal("a"),
      z.literal("b"),
    ]),
  ]) {
    const exhaustive = z.record(keys, z.string().exactOptional());
    const partial = z.partialRecord(keys, z.string().exactOptional());
    // Wrappers and repeated references must retain the record's required keys.
    for (const record of [
      exhaustive,
      partial,
    ]) {
      for (const schema of [
        record,
        record.nullable(),
        z.array(record),
        z.lazy(() => record),
      ]) {
        const plugin = defineNativePlugin({
          name: "records",
          operations: {
            echo: {
              input: schema,
              output: schema,
            },
          },
        });
        const registry = new NativeRegistry([
          structuredClone(plugin.definition),
        ]);
        for (const value of [
          {},
          {
            a: "ok",
          },
          {
            a: "ok",
            b: "ok",
          },
          {
            c: "bad",
          },
        ]) {
          const payload =
            schema instanceof z.ZodArray
              ? [
                  value,
                ]
              : value;
          const parsed = schema.safeParse(payload);
          if (parsed.success) {
            expect(
              registry.validateCall({
                operation: "records.echo",
                payload,
              }).payload,
            ).toEqual(parsed.data);
            expect(registry.validateOutput("records.echo", payload)).toEqual(
              parsed.data,
            );
          } else {
            expect(() =>
              registry.validateCall({
                operation: "records.echo",
                payload,
              }),
            ).toThrow();
            expect(() =>
              registry.validateOutput("records.echo", payload),
            ).toThrow();
          }
        }
      }
    }
    const repeated = z.record(keys, z.string().exactOptional());
    const schema = z.strictObject({
      first: repeated,
      second: repeated,
    });
    const portable = JSON.parse(JSON.stringify(toJSONSchema(schema)));
    expect(
      validateValue(portable, {
        first: {
          a: "ok",
          b: "ok",
        },
        second: {
          a: "ok",
          b: "ok",
        },
      }),
    ).toEqual({
      first: {
        a: "ok",
        b: "ok",
      },
      second: {
        a: "ok",
        b: "ok",
      },
    });
    expect(() =>
      validateValue(portable, {
        first: {
          a: "ok",
          b: "ok",
        },
        second: {},
      }),
    ).toThrow();
  }
});

test("custom string checks are rejected and standalone regular expressions retain their rules", () => {
  for (const schema of [
    z.stringFormat("time", (value) => value === "12:00"),
    z.stringFormat("regex", (value) => value === "allowed"),
    z.string().check(z.stringFormat("time", (value) => value === "12:00")),
    z.object({
      time: z.stringFormat("time", (value) => value === "12:00"),
    }),
  ]) {
    for (const operation of [
      {
        input: schema,
        output: z.null(),
      },
      {
        input: z.null(),
        output: schema,
      },
    ]) {
      expect(() =>
        defineNativePlugin({
          name: "invalid",
          operations: {
            echo: operation,
          },
        }),
      ).toThrow(
        "Plugin schemas cannot transform values or contain custom checks.",
      );
    }
  }
  for (const pattern of [
    /^a$/,
    /^a$/iu,
  ]) {
    expect(() => toJSONSchema(z.stringFormat("regex", pattern))).toThrow(
      "Plugin regular expressions must use only the Unicode flag.",
    );
  }
  const schema = z.stringFormat("regex", /^a$/u);
  const registry = new NativeRegistry([
    defineNativePlugin({
      name: "pattern",
      operations: {
        echo: {
          input: schema,
          output: schema,
        },
      },
    }).definition,
  ]);
  expect(
    registry.validateCall({
      operation: "pattern.echo",
      payload: "a",
    }).payload,
  ).toBe("a");
  expect(registry.validateOutput("pattern.echo", "a")).toBe("a");
  expect(() =>
    registry.validateCall({
      operation: "pattern.echo",
      payload: "A",
    }),
  ).toThrow();
  expect(() => registry.validateOutput("pattern.echo", "A")).toThrow();
});

test("recursive JSON stays bounded and references cannot access external or inherited schemas", () => {
  const schema = toJSONSchema(z.json());
  expect(Object.getOwnPropertyNames(schema)).not.toContain("~standard");
  expect(structuredClone(schema)).toEqual(schema);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [
    cycle,
    {
      missing: undefined,
    },
    {
      number: Infinity,
    },
    new Date(),
  ]) {
    expect(() => validateValue(schema, value)).toThrow();
  }
  for (const reference of [
    "https://example.com/schema",
    "#/missing",
    "#/__proto__",
  ]) {
    expect(
      () =>
        new NativeRegistry([
          {
            name: "invalid",
            version: "1",
            native: {
              operations: [
                {
                  name: "invalid.read",
                  input: {
                    $ref: reference,
                  },
                  output: {
                    const: null,
                  },
                },
              ],
            },
          },
        ]),
    ).toThrow();
  }
  expect(() =>
    validateValue(
      {
        $ref: "#",
      },
      null,
    ),
  ).toThrow();
  for (const input of [
    {
      type: "string",
      "x-bunaway-stripUnknown": true,
    },
    {
      type: "object",
      "x-bunaway-stripUnknown": false,
    },
    {
      type: "object",
      additionalProperties: false,
      "x-bunaway-stripUnknown": true,
    },
    {
      $defs: [],
    },
    {
      propertyNames: false,
    },
    {
      additionalProperties: null,
    },
  ]) {
    expect(
      () =>
        new NativeRegistry([
          {
            name: "invalid",
            version: "1",
            native: {
              operations: [
                {
                  name: "invalid.read",
                  input: JSON.parse(JSON.stringify(input)),
                  output: {
                    const: null,
                  },
                },
              ],
            },
          },
        ]),
    ).toThrow();
  }
});

test("object stripping owns its result and preserves JSON limits before removing fields", () => {
  const definition = z.object({
    name: z.string(),
  });
  const schema = toJSONSchema(definition);
  const input = JSON.parse(
    '{"name":"ok","extra":true,"__proto__":{"name":"other"}}',
  );
  const expected = {
    name: "ok",
  };
  expect(validateValue(schema, input)).toEqual(expected);
  expect(parse(schema, JSON.stringify(input))).toEqual(expected);
  expect(JSON.parse(serialize(schema, input))).toEqual(expected);
  expect(input.extra).toBe(true);
  expect(Object.hasOwn(input, "__proto__")).toBe(true);
  let deep: unknown = null;
  for (let depth = 0; depth <= MAX_JSON_DEPTH; depth++) {
    deep = {
      child: deep,
    };
  }
  for (const extra of [
    undefined,
    Infinity,
    new Date(),
    "x".repeat(MAX_MESSAGE_BYTES),
    deep,
  ]) {
    expect(() =>
      validateValue(schema, {
        name: "ok",
        extra,
      }),
    ).toThrow();
  }
  // Explicit JSON schemas retain their existing additional-properties policy.
  expect(
    validateValue(
      {
        type: "object",
      },
      {
        name: "ok",
        extra: true,
      },
    ),
  ).toEqual({
    name: "ok",
    extra: true,
  });
});

test("recursive object definitions remove unknown fields through local references", () => {
  type Tree = {
    name: string;
    children?: Tree[];
  };
  const tree: z.ZodType<Tree> = z.lazy(() =>
    z.object({
      name: z.string(),
      children: z.array(tree).exactOptional(),
    }),
  );
  const input = {
    name: "parent",
    extra: true,
    children: [
      {
        name: "child",
        extra: true,
      },
    ],
  };
  const schema = JSON.parse(JSON.stringify(toJSONSchema(tree)));
  expect(validateValue(schema, input)).toEqual(tree.parse(input));
});

test("a real Worker validates the serialized contract without declaration functions", async () => {
  const schema = z.object({
    name: z.string(),
    details: z.json().exactOptional(),
  });
  const plugin = defineNativePlugin({
    name: "worker",
    operations: {
      echo: {
        input: schema,
        output: schema,
      },
    },
  });
  const worker = new Worker(
    new URL("../fixtures/plugin-schema-worker.ts", import.meta.url).href,
  );
  try {
    const reply = new Promise<unknown>((resolve, reject) => {
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = reject;
    });
    worker.postMessage({
      definition: plugin.definition,
      values: [
        {
          name: "ok",
          details: [
            null,
            true,
          ],
        },
        {
          name: "ok",
          extra: true,
        },
        {},
      ],
    });
    expect(await reply).toEqual([
      {
        input: {
          name: "ok",
          details: [
            null,
            true,
          ],
        },
        output: {
          name: "ok",
          details: [
            null,
            true,
          ],
        },
      },
      {
        input: {
          name: "ok",
        },
        output: {
          name: "ok",
        },
      },
      false,
    ]);
  } finally {
    worker.terminate();
  }
});
