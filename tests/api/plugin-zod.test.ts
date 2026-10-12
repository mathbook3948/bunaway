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
import { checkPluginSchema } from "../../packages/protocol/src/plugin-schema.ts";
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
      schema: z.string().check(z.minLength(2), z.maxLength(3)),
      values: [
        "a",
        "ab",
        "abc",
        "abcd",
      ],
    },
    {
      schema: z.string().check(z.length(2)),
      values: [
        "a",
        "ab",
        "abc",
      ],
    },
    {
      schema: z.array(z.number()).check(z.minLength(1), z.maxLength(2)),
      values: [
        [],
        [
          1,
        ],
        [
          1,
          2,
        ],
        [
          1,
          2,
          3,
        ],
      ],
    },
    {
      schema: z.number().check(z.gte(1), z.lte(3), z.multipleOf(2)).nullable(),
      values: [
        0,
        1,
        2,
        3,
        4,
        null,
      ],
    },
    {
      schema: z.string().regex(/^.$/u),
      values: [
        "a",
        "😀",
        "ab",
        "",
      ],
    },
    {
      schema: z.literal([
        null,
        true,
        1.5,
        "😀",
      ]),
      values: [
        null,
        true,
        false,
        1.5,
        2,
        "😀",
      ],
    },
    {
      schema: z.record(z.literal("a"), z.string()),
      values: [
        {
          a: "ok",
        },
        {
          a: "ok",
          extra: 1,
        },
        {},
      ],
    },
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
      schema: z.record(
        z.lazy(() => z.string().regex(/^[a-z]+$/u)),
        z.int(),
      ),
      values: [
        {
          a: 1,
        },
        {
          A: 1,
        },
        {
          a: "bad",
        },
      ],
    },
    {
      schema: z.record(
        z.literal([
          1,
          2,
        ]),
        z.string().exactOptional(),
      ),
      values: [
        {
          1: "a",
          2: "b",
        },
        {},
        {
          1: "a",
        },
        {
          3: "c",
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

test("source policy rejects lossy declarations in either operation boundary and nested graphs", () => {
  const template = z.templateLiteral([
    z.string().regex(/^.$/u),
  ]);
  const loose = z.looseRecord(z.literal("a"), z.string());
  const infinite = z.literal([
    Infinity,
    true,
  ]);
  expect(template.safeParse("😀").success).toBe(false);
  expect(
    loose.safeParse({
      a: "ok",
      extra: 1,
    }).success,
  ).toBe(true);
  expect(infinite.safeParse(null).success).toBe(false);
  for (const unsupported of [
    template,
    z.templateLiteral([
      "fixed",
    ]),
    loose,
    z.looseRecord(z.string().regex(/^a$/u), z.string()),
    infinite,
    z.literal(-Infinity),
    z.literal(NaN),
    z.promise(z.string()),
    z.string().readonly(),
  ]) {
    const shared = z.lazy(() => unsupported);
    const recursive: z.ZodType = z.lazy(() =>
      z.object({
        value: shared,
        children: z.array(recursive),
      }),
    );
    for (const schema of [
      unsupported,
      z.object({
        value: unsupported.exactOptional(),
      }),
      z.array(unsupported),
      z.union([
        z.null(),
        shared,
      ]),
      z.object({
        first: shared,
        second: shared,
      }),
      z.record(z.string(), shared),
      recursive,
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
        ).toThrow();
      }
    }
  }
});

test("contract validation rejects non-JSON literals before serialization and at registration", () => {
  for (const value of [
    Infinity,
    -Infinity,
    NaN,
    undefined,
  ]) {
    for (const literal of [
      {
        const: value,
      },
      {
        enum: [
          value,
          true,
        ],
      },
    ]) {
      for (const schema of [
        literal,
        {
          type: "array",
          items: literal,
        },
        {
          $defs: {
            value: literal,
          },
          $ref: "#/$defs/value",
        },
      ]) {
        expect(() => checkPluginSchema(schema)).toThrow(
          "Plugin schema literals must be finite JSON values.",
        );
        for (const operation of [
          {
            input: schema,
            output: {
              type: "null",
            },
          },
          {
            input: {
              type: "null",
            },
            output: schema,
          },
        ]) {
          expect(() =>
            Reflect.construct(NativeRegistry, [
              [
                {
                  name: "invalid",
                  version: "1",
                  native: {
                    operations: [
                      {
                        name: "invalid.echo",
                        ...operation,
                      },
                    ],
                  },
                },
              ],
            ]),
          ).toThrow();
        }
      }
    }
  }
});

test("built-in checks require an owner that serializes their constraints", () => {
  for (const { schema, rejected } of [
    {
      schema: z
        .enum([
          "a",
          "bb",
        ])
        .check(z.minLength(2)),
      rejected: "a",
    },
    {
      schema: z.literal("aa").check(z.maxLength(1)),
      rejected: "aa",
    },
    {
      schema: z.literal("a").check(z.length(2)),
      rejected: "a",
    },
    {
      schema: z
        .enum([
          "a",
          "b",
        ])
        .check(z.regex(/^b$/u)),
      rejected: "a",
    },
    {
      schema: z.literal(1).check(z.gte(2)),
      rejected: 1,
    },
    {
      schema: z
        .union([
          z.literal(1),
          z.literal(3),
        ])
        .check(z.lte(2)),
      rejected: 3,
    },
    {
      schema: z.number().optional().nonoptional().check(z.multipleOf(2)),
      rejected: 3,
    },
    {
      schema: z.intersection(z.string(), z.string()).check(z.minLength(2)),
      rejected: "a",
    },
    {
      schema: z.lazy(() => z.string()).check(z.minLength(2)),
      rejected: "a",
    },
  ]) {
    expect(schema.safeParse(rejected).success).toBe(false);
    const recursive: z.ZodType = z.lazy(() =>
      z.object({
        value: schema,
        children: z.array(recursive),
      }),
    );
    for (const declaration of [
      schema,
      z.object({
        value: schema,
      }),
      recursive,
    ]) {
      expect(() => toJSONSchema(declaration)).toThrow();
      for (const operation of [
        {
          input: declaration,
          output: z.null(),
        },
        {
          input: z.null(),
          output: declaration,
        },
      ]) {
        expect(() =>
          defineNativePlugin({
            name: "invalid",
            operations: {
              echo: operation,
            },
          }),
        ).toThrow();
      }
    }
  }
});

test("reference targets are validated as schemas at both registration boundaries", () => {
  for (const schema of [
    {
      $ref: "#/properties",
      properties: {
        type: {
          type: "number",
        },
      },
    },
    {
      $ref: "#/$defs",
      $defs: {
        enum: {
          type: "string",
        },
      },
    },
    {
      $ref: "#/$defs/alias",
      $defs: {
        alias: {
          $ref: "#/properties",
        },
      },
      properties: {
        type: {
          type: "number",
        },
      },
    },
    {
      $ref: "#",
      properties: {
        nested: {
          $ref: "#/properties",
        },
      },
    },
  ]) {
    expect(() => checkPluginSchema(schema)).toThrow();
    for (const operation of [
      {
        input: schema,
        output: {
          type: "null",
        },
      },
      {
        input: {
          type: "null",
        },
        output: schema,
      },
    ]) {
      expect(() =>
        Reflect.construct(NativeRegistry, [
          [
            {
              name: "invalid",
              version: "1",
              native: {
                operations: [
                  {
                    name: "invalid.echo",
                    ...operation,
                  },
                ],
              },
            },
          ],
        ]),
      ).toThrow();
    }
  }
});

test("validated references preserve mutual recursion, escaped keys and shared constraints", () => {
  const schema = {
    $ref: "#/$defs/node",
    $defs: {
      node: {
        anyOf: [
          {
            type: "null",
          },
          {
            type: "object",
            properties: {
              value: {
                $ref: "#/$defs/a~1b~0c",
              },
              next: {
                $ref: "#/$defs/link",
              },
            },
            required: [
              "value",
              "next",
            ],
            additionalProperties: false,
          },
        ],
      },
      link: {
        $ref: "#/$defs/node",
      },
      "a/b~c": {
        type: "number",
        minimum: 1,
      },
    },
  } as const;
  checkPluginSchema(schema);
  const registry = new NativeRegistry([
    {
      name: "test",
      version: "1",
      native: {
        operations: [
          {
            name: "test.echo",
            input: schema,
            output: schema,
          },
        ],
      },
    },
  ]);
  for (const value of [
    null,
    {
      value: 1,
      next: {
        value: 2,
        next: null,
      },
    },
  ]) {
    expect(
      registry.validateCall({
        operation: "test.echo",
        payload: value,
      }).payload,
    ).toEqual(value);
    expect(registry.validateOutput("test.echo", value)).toEqual(value);
  }
  for (const value of [
    "anything",
    {
      value: 1,
      next: {
        value: 0,
        next: null,
      },
    },
    {
      value: 1,
    },
  ]) {
    expect(() =>
      registry.validateCall({
        operation: "test.echo",
        payload: value,
      }),
    ).toThrow();
    expect(() => registry.validateOutput("test.echo", value)).toThrow();
  }
  // Revisiting a root must not hide invalid siblings later in the same graph.
  expect(() =>
    checkPluginSchema({
      ...schema,
      $defs: {
        ...schema.$defs,
        invalidSibling: {
          type: "invalid",
        },
      },
    }),
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
  const wrapped = z.lazy(() =>
    z.union([
      z.string(),
      shared,
    ]),
  );
  // Reuse in a value position must not hide a later numeric record key.
  for (const schema of [
    z.strictObject({
      id: wrapped,
      values: z.record(wrapped, z.string()),
    }),
    z.strictObject({
      values: z.record(wrapped, z.string()),
      id: wrapped,
    }),
  ]) {
    expect(() => toJSONSchema(schema)).toThrow(
      "Plugin record keys cannot use numeric schemas.",
    );
  }
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
