import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import { z as esm } from "zod";

// Both published module formats must carry the same patch.
const z: typeof esm = workerData === "cjs" ? require("zod").z : esm;
const late = async () => {
  await Bun.sleep(5);
  throw new Error("late failure");
};
const fail = () => {
  throw new Error("immediate failure");
};
const pending = () => new Promise<boolean>(() => {});
const delayed = z.string().refine(late);
const immediate = z.string().refine(fail);
const byValue = z
  .string()
  .refine((value) => (value === "late" ? late() : fail()));
const cases: [
  esm.ZodType,
  unknown,
][] = [
  [
    delayed.refine(fail),
    "ok",
  ],
  [
    delayed.refine(() => true, {
      when: fail,
    }),
    "ok",
  ],
  [
    z.object({
      a: delayed,
      b: immediate,
    }),
    {
      a: "ok",
      b: "ok",
    },
  ],
  [
    z
      .object({
        a: delayed,
      })
      .catchall(immediate),
    {
      a: "ok",
      b: "ok",
    },
  ],
  [
    z.array(byValue),
    [
      "late",
      "fail",
    ],
  ],
  [
    z.tuple([
      delayed,
      immediate,
    ]),
    [
      "ok",
      "ok",
    ],
  ],
  [
    z.tuple([]).rest(byValue),
    [
      "late",
      "fail",
    ],
  ],
  [
    z.union([
      delayed,
      immediate,
    ]),
    "ok",
  ],
  [
    z.xor([
      delayed,
      immediate,
    ]),
    "ok",
  ],
  [
    z.intersection(delayed, immediate),
    "ok",
  ],
  [
    z.record(z.string(), byValue),
    {
      a: "late",
      b: "fail",
    },
  ],
  [
    z.record(
      z.enum([
        "a",
        "b",
      ]),
      byValue,
    ),
    {
      a: "late",
      b: "fail",
    },
  ],
  [
    z.record(delayed, z.string()),
    {
      a: "ok",
    },
  ],
  [
    z.map(delayed, immediate),
    new Map([
      [
        "ok",
        "ok",
      ],
    ]),
  ],
  [
    z.map(z.string(), byValue),
    new Map([
      [
        "a",
        "late",
      ],
      [
        "b",
        "fail",
      ],
    ]),
  ],
  [
    z.set(byValue),
    new Set([
      "late",
      "fail",
    ]),
  ],
  [
    z.unknown().check(
      z.properties({
        a: delayed,
        b: immediate,
      }),
    ),
    {
      a: "ok",
      b: "ok",
    },
  ],
  [
    z.object({
      a: z.string().refine(pending),
      b: delayed,
      c: immediate,
    }),
    {
      a: "ok",
      b: "ok",
      c: "ok",
    },
  ],
  [
    z.string().refine(pending).refine(late),
    "ok",
  ],
  [
    delayed.refine(pending),
    "ok",
  ],
];

for (const wrapped of [
  delayed.optional(),
  delayed.default("default"),
  delayed.catch("fallback"),
  delayed.readonly(),
  delayed.pipe(z.string()),
  z.string().transform(late),
  z.promise(delayed),
  z.lazy(() => delayed),
]) {
  cases.push([
    z.object({
      a: wrapped,
      b: immediate,
    }),
    {
      a: "ok",
      b: "ok",
    },
  ]);
}
for (const [schema, input] of cases) {
  // The harness times out if rejection starts waiting for a never-settling sibling.
  await assert.rejects(async () => schema.parseAsync(input));
}
// A successful union alternative must keep its original short-circuit result.
assert.equal(
  await z
    .union([
      delayed,
      z.string(),
    ])
    .parseAsync("ok"),
  "ok",
);
for (const schema of [
  delayed,
  z.string().transform(late),
  z.array(delayed),
  z.promise(z.string()),
]) {
  assert.throws(() =>
    schema.parse(
      schema instanceof z.ZodArray
        ? [
            "ok",
          ]
        : "ok",
    ),
  );
}
let transforms = 0;
let checks = 0;
let whens = 0;
const normal = z
  .object({
    value: z
      .string()
      .trim()
      .transform(async (value) => {
        transforms++;
        return value.length;
      }),
    fallback: z.string().default("default"),
  })
  .refine(
    () => {
      checks++;
      return true;
    },
    {
      when: () => {
        whens++;
        return true;
      },
    },
  );
assert.deepEqual(
  await normal.parseAsync({
    value: " hi ",
  }),
  {
    value: 2,
    fallback: "default",
  },
);
assert.deepEqual(
  [
    transforms,
    checks,
    whens,
  ],
  [
    1,
    1,
    1,
  ],
);
let skipped = 0;
assert.equal(
  (
    await z
      .string()
      .refine(() => false, {
        abort: true,
      })
      .refine(() => {
        skipped++;
        return true;
      })
      .safeParseAsync("ok")
  ).success,
  false,
);
assert.equal(skipped, 0);
const order: string[] = [];
const asynchronousAbort = await z
  .string()
  .refine(
    async () => {
      order.push("first");
      await Bun.sleep(1);
      return false;
    },
    {
      abort: true,
    },
  )
  .refine(() => {
    order.push("second");
    return true;
  })
  .safeParseAsync("ok");
assert.equal(asynchronousAbort.success, false);
assert.deepEqual(order, [
  "first",
  "second",
]);
const condition = {
  abort: false,
  when: ({ value }: { value: unknown }) => value !== 0,
};
assert.equal(await z.number().check(z.gte(10, condition)).parseAsync(0), 0);
// Report success only after delayed failures have had a chance to escape.
await Bun.sleep(30);
assert.equal(await z.string().parseAsync("next request"), "next request");
parentPort?.postMessage("alive");
parentPort?.close();
