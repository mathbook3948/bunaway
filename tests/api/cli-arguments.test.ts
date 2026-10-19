import { expect, test } from "bun:test";
import { type CLIGroup, defineCLI } from "@bunaway/backend/cli";
import { z } from "zod";

const definition = {
  name: "memo",
  description: "Manage notes",
  commands: {
    docs: {
      description: "Document tools",
      commands: {
        export: {
          description: "Export documents",
          options: {
            count: {
              type: "string",
              short: "c",
              description: "Export count",
            },
            label: {
              type: "string",
              multiple: true,
            },
            verbose: {
              type: "boolean",
              short: "v",
            },
          },
          schema: z
            .strictObject({
              values: z.strictObject({
                count: z.coerce.number().int().min(1).max(10).default(1),
                label: z.array(z.string()).default([]),
                verbose: z.boolean().default(false),
              }),
              positionals: z.array(z.string()).min(1),
            })
            .transform(({ values, positionals }) => ({
              ...values,
              files: positionals,
            })),
        },
      },
    },
    version: {
      schema: z
        .strictObject({
          values: z.strictObject({}),
          positionals: z.tuple([]),
        })
        .transform(() => ({
          version: 1,
        })),
    },
  },
} as const;

test("nested command matches infer schema output and preserve aliases, repeats and -- positionals", async () => {
  const cli = defineCLI(definition);
  const result = await cli.parse([
    "docs",
    "export",
    "-vc",
    "3",
    "--label",
    "한글",
    "--label=😀",
    "--",
    "-draft.txt",
    'quoted" file.txt',
  ]);
  expect(result).toEqual({
    kind: "match",
    command: "docs export",
    data: {
      count: 3,
      label: [
        "한글",
        "😀",
      ],
      verbose: true,
      files: [
        "-draft.txt",
        'quoted" file.txt',
      ],
    },
  });
  if (result.kind === "match" && result.command === "docs export") {
    const count: number = result.data.count;
    const files: string[] = result.data.files;
    expect(count).toBe(3);
    expect(files).toHaveLength(2);
  }
  const defaults = await cli.parse([
    "docs",
    "export",
    "note.txt",
  ]);
  expect(defaults).toMatchObject({
    data: {
      count: 1,
      label: [],
      verbose: false,
    },
  });
  expect(
    await cli.parse([
      "version",
    ]),
  ).toEqual({
    kind: "match",
    command: "version",
    data: {
      version: 1,
    },
  });
});

test("help is generated per selected command without executing required business schemas", async () => {
  let parsed = 0;
  const cli = defineCLI({
    name: "app",
    commands: {
      open: {
        description: "Open a file",
        options: {
          title: {
            type: "string",
            short: "t",
            description: "Window title",
          },
        },
        schema: z.unknown().superRefine(() => {
          parsed++;
          throw new Error("Must not run for help");
        }),
      },
    },
  });
  expect(await cli.parse([])).toMatchObject({
    kind: "help",
    command: "",
    help: expect.stringContaining("open  Open a file"),
  });
  const result = await cli.parse([
    "open",
    "--help",
  ]);
  expect(result.kind).toBe("help");
  if (result.kind !== "help") {
    throw new Error("Expected help");
  }
  expect(result.command).toBe("open");
  expect(result.help).toContain("-t, --title <value>  Window title");
  expect(parsed).toBe(0);
  expect(
    cli.help([
      "open",
    ]),
  ).toBe(result.help);
  expect(() =>
    cli.help([
      "missing",
    ]),
  ).toThrow(TypeError);
});

test("syntax and schema failures are distinct recoverable results; later parses still work", async () => {
  const cli = defineCLI(definition);
  for (const argv of [
    [
      "missing",
    ],
    [
      "",
    ],
    [
      "docs",
      "missing",
    ],
    [
      "docs",
      "export",
      "--unknown",
    ],
    [
      "docs",
      "export",
      "--count",
    ],
    [
      "docs",
      "export",
      "--verbose=true",
    ],
    [
      "docs",
      "export",
      "--help",
      "--unknown",
    ],
  ]) {
    expect(await cli.parse(argv)).toMatchObject({
      kind: "error",
      error: {
        code: "INVALID_ARGUMENT",
        reason: "arguments",
      },
    });
  }
  for (const argv of [
    [
      "docs",
      "export",
    ],
    [
      "docs",
      "export",
      "--count=bad",
      "file",
    ],
    [
      "docs",
      "export",
      "--count=11",
      "file",
    ],
  ]) {
    expect(await cli.parse(argv)).toMatchObject({
      kind: "error",
      error: {
        reason: "schema",
        issues: expect.any(Array),
      },
    });
  }
  expect(
    await cli.parse([
      "docs",
      "export",
      "--count=2",
      "file",
    ]),
  ).toMatchObject({
    kind: "match",
    data: {
      count: 2,
    },
  });
});

test("async parsing owns one snapshot, runs its schema once and contains thrown callback failures", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const schema = z
    .strictObject({
      values: z.strictObject({}),
      positionals: z.array(z.string()),
    })
    .transform(async (input) => {
      calls++;
      await gate;
      return input.positionals;
    });
  const options: Record<
    string,
    {
      type: "boolean";
    }
  > = {};
  const cli = defineCLI({
    name: "app",
    options,
    schema,
  });
  options.late = {
    type: "boolean",
  };
  const argv = [
    "한글 😀",
  ];
  const pending = cli.parse(argv);
  argv[0] = "changed";
  release();
  expect(await pending).toEqual({
    kind: "match",
    command: "",
    data: [
      "한글 😀",
    ],
  });
  expect(calls).toBe(1);
  expect(
    await cli.parse([
      "--late",
    ]),
  ).toMatchObject({
    kind: "error",
    error: {
      reason: "arguments",
    },
  });
  const broken = defineCLI({
    name: "app",
    schema: z.unknown().transform(async () => {
      throw 0;
    }),
  });
  expect(await broken.parse([])).toMatchObject({
    kind: "error",
    error: {
      reason: "schema",
      message: "CLI argument validation failed.",
    },
  });
});

test("definition and argv bounds reject reserved aliases, cycles, excessive data and malformed Unicode", async () => {
  const schema = z.unknown();
  for (const options of [
    {
      help: {
        type: "boolean" as const,
      },
    },
    {
      own: {
        type: "boolean" as const,
        short: "h",
      },
    },
    {
      a: {
        type: "string" as const,
        short: "x",
      },
      b: {
        type: "boolean" as const,
        short: "x",
      },
    },
  ]) {
    expect(() =>
      defineCLI({
        name: "app",
        options,
        schema,
      }),
    ).toThrow(TypeError);
  }
  const commands: Record<string, CLIGroup> = {};
  const cycle: CLIGroup = {
    description: "cycle",
    commands,
  };
  commands.loop = cycle;
  expect(() =>
    defineCLI({
      name: "app",
      commands,
    }),
  ).toThrow(TypeError);
  const cli = defineCLI({
    name: "app",
    schema,
  });
  for (const argv of [
    [
      "\0",
    ],
    [
      "\ud800",
    ],
    [
      "x".repeat(4097),
    ],
    Array(257).fill("x"),
    Array(32).fill("😀".repeat(1024)),
    new Array<string>(1),
  ]) {
    expect(await cli.parse(argv)).toMatchObject({
      kind: "error",
      error: {
        reason: "arguments",
      },
    });
  }
});

test("malformed definitions are rejected with a message naming the broken part", () => {
  const command = {
    schema: z.object({}),
  };
  const reject = (definition: unknown, message: string) =>
    expect(() => defineCLI(definition as never)).toThrow(message);
  reject(
    {
      name: "",
      ...command,
    },
    "Invalid CLI name.",
  );
  reject(
    {
      name: "x".repeat(129),
      ...command,
    },
    "Invalid CLI name.",
  );
  reject(
    {
      name: "app",
      description: "bad\u0000text",
      ...command,
    },
    "Invalid CLI description.",
  );
  reject(
    {
      name: "app",
      extra: 1,
      ...command,
    },
    "Unknown CLI definition field.",
  );
  reject(
    {
      name: "app",
      schema: {},
    },
    "CLI commands require a Zod schema.",
  );
  reject(
    {
      name: "app",
      options: [],
      ...command,
    },
    "Invalid CLI options.",
  );
  reject(
    {
      name: "app",
      options: Object.fromEntries(
        Array.from(
          {
            length: 65,
          },
          (_, index) => [
            `o${index}`,
            {
              type: "boolean",
            },
          ],
        ),
      ),
      ...command,
    },
    "Invalid CLI options.",
  );
  reject(
    {
      name: "app",
      options: {
        Bad: {
          type: "boolean",
        },
      },
      ...command,
    },
    "Invalid or reserved CLI option.",
  );
  reject(
    {
      name: "app",
      options: {
        a: {
          type: "boolean",
          short: "h",
        },
      },
      ...command,
    },
    "Duplicate or reserved CLI short option.",
  );
  reject(
    {
      name: "app",
      commands: [],
    },
    "Invalid CLI subcommands.",
  );
  reject(
    {
      name: "app",
      commands: {
        Bad: command,
      },
    },
    "Invalid CLI subcommand name.",
  );
  reject(
    {
      name: "app",
      commands: {},
    },
    "CLI groups require a subcommand.",
  );
  let deep: unknown = command;
  for (let depth = 0; depth < 10; depth++) {
    deep = {
      commands: {
        next: deep,
      },
    };
  }
  reject(
    {
      name: "app",
      ...(deep as object),
    },
    "Invalid CLI command tree.",
  );
});
