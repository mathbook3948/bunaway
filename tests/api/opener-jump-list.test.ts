import { expect, test } from "bun:test";
import opener from "@bunaway/plugin-opener";
import { NativeRegistry } from "@bunaway/protocol";
import {
  jumpListResultSchema,
  MAX_JUMP_LIST_CATEGORIES,
  MAX_JUMP_LIST_ITEMS,
  validateOpenerInput,
} from "#plugins/opener/src/contract";
import {
  macosOperations,
  windowsOperations,
} from "#plugins/opener/src/operations";
import {
  buildJumpListArguments,
  entryArguments,
  parseArgumentLine,
} from "#plugins/opener/src/platforms/windows-jump-list-command";
import { normalizeJumpList } from "#plugins/opener/src/platforms/windows-path";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("opener", windowsOperations);
const registry = new NativeRegistry([
  opener._definition,
]);

const LAUNCH = {
  mode: "development" as const,
  executablePath: "C:\\Program Files\\App\\bun.exe",
  args: [
    "C:\\apps\\main.ts",
  ],
};

const task = (title: string, extra: Record<string, unknown> = {}) => ({
  type: "task" as const,
  title,
  ...extra,
});

const invalid = expect.objectContaining({
  code: "INVALID_ARGUMENT",
});

test("a list holds tasks, separators and custom categories", () => {
  const input = {
    categories: [
      {
        type: "tasks",
        items: [
          task("New window", {
            args: [
              "--new",
            ],
            cwd: "c:/work",
            iconPath: "c:/work/app.ico",
            iconIndex: 2,
            description: "Opens a window",
          }),
          {
            type: "separator",
          },
          task("Settings"),
        ],
      },
      {
        type: "custom",
        name: "Recent projects",
        items: [
          task("Project"),
        ],
      },
    ],
  };
  expect(validateOpenerInput("opener.setJumpList", input)).toMatchObject(input);
  const normalized = normalizeJumpList(input);
  expect(normalized.categories[0]?.items[0]).toMatchObject({
    cwd: "C:\\work",
    iconPath: "C:\\work\\app.ico",
  });
});

test("list inputs reject separators in custom categories, a second tasks category and bad shapes", () => {
  const tasks = {
    type: "tasks",
    items: [
      task("A"),
    ],
  };
  for (const input of [
    {},
    {
      categories: [],
    },
    {
      categories: [
        tasks,
        tasks,
      ],
    },
    {
      categories: [
        {
          type: "custom",
          name: "C",
          items: [
            {
              type: "separator",
            },
          ],
        },
      ],
    },
    {
      categories: [
        {
          type: "custom",
          name: "",
          items: [
            task("A"),
          ],
        },
      ],
    },
    {
      categories: [
        {
          type: "tasks",
          items: [],
        },
      ],
    },
    {
      categories: [
        {
          type: "tasks",
          items: [
            task(""),
          ],
        },
      ],
    },
    {
      categories: [
        {
          type: "tasks",
          items: [
            task("A", {
              program: "C:\\Windows\\notepad.exe",
            }),
          ],
        },
      ],
    },
    {
      categories: [
        {
          type: "tasks",
          items: [
            task("A", {
              iconIndex: 1.5,
            }),
          ],
        },
      ],
    },
    {
      categories: [
        tasks,
      ],
      extra: 1,
    },
  ]) {
    expect(() => validateOpenerInput("opener.setJumpList", input)).toThrow(
      invalid,
    );
    expect(() => normalizeJumpList(input)).toThrow(invalid);
  }
});

test("task paths must be absolute Windows paths", () => {
  for (const path of [
    {
      cwd: "relative",
    },
    {
      iconPath: "%SystemRoot%\\system32\\shell32.dll",
    },
  ]) {
    expect(() =>
      normalizeJumpList({
        categories: [
          {
            type: "tasks",
            items: [
              task("A", path),
            ],
          },
        ],
      }),
    ).toThrow(invalid);
  }
});

test("titles, arguments and sizes are bounded", () => {
  const list = (items: unknown[], count = 1) => ({
    categories: Array.from(
      {
        length: count,
      },
      (_value, position) => ({
        type: "custom",
        name: `C${position}`,
        items,
      }),
    ),
  });
  expect(() =>
    normalizeJumpList(
      list([
        task("x".repeat(260)),
      ]),
    ),
  ).not.toThrow();
  for (const bad of [
    task("x".repeat(261)),
    task("tab\there"),
    task("A", {
      description: "x".repeat(261),
    }),
    task("A", {
      args: [
        "50%",
      ],
    }),
    task("A", {
      args: [
        "line\nbreak",
      ],
    }),
    task("A", {
      args: Array.from(
        {
          length: 65,
        },
        () => "a",
      ),
    }),
  ]) {
    expect(() =>
      normalizeJumpList(
        list([
          bad,
        ]),
      ),
    ).toThrow(invalid);
  }
  expect(() =>
    normalizeJumpList(
      list(
        [
          task("A"),
        ],
        MAX_JUMP_LIST_CATEGORIES,
      ),
    ),
  ).not.toThrow();
  expect(() =>
    normalizeJumpList(
      list(
        [
          task("A"),
        ],
        MAX_JUMP_LIST_CATEGORIES + 1,
      ),
    ),
  ).toThrow(invalid);
  const many = Array.from(
    {
      length: MAX_JUMP_LIST_ITEMS + 1,
    },
    () => task("A"),
  );
  expect(() => normalizeJumpList(list(many))).toThrow(invalid);
  expect(() => normalizeJumpList(list(many.slice(1)))).not.toThrow();
});

test("operations without parameters accept only an empty object", () => {
  for (const operation of [
    "opener.getJumpListRemovedItems",
    "opener.deleteJumpList",
  ]) {
    expect(validateOpenerInput(operation, {})).toEqual({});
    expect(() =>
      validateOpenerInput(operation, {
        extra: 1,
      }),
    ).toThrow(invalid);
  }
});

test("the Jump List operations are Windows only and each has its own permission", async () => {
  const operations = [
    "setJumpList",
    "getJumpListRemovedItems",
    "deleteJumpList",
  ];
  for (const operation of operations) {
    expect(Object.keys(windowsOperations)).toContain(operation);
    expect(Object.keys(macosOperations)).not.toContain(operation);
  }
  const grant = (name: string) => ({
    permissions: [
      name,
    ],
  });
  for (const operation of operations) {
    const call = await parsers.validateCall({
      operation: `opener.${operation}`,
      payload:
        operation === "setJumpList"
          ? {
              categories: [
                {
                  type: "tasks",
                  items: [
                    task("A"),
                  ],
                },
              ],
            }
          : {},
    });
    for (const other of operations) {
      expect(registry.allowed(grant(`opener.${other}`), call)).toBe(
        other === operation,
      );
    }
  }
  expect(
    jumpListResultSchema.safeParse("customCategoryAccessDenied").success,
  ).toBe(true);
  expect(jumpListResultSchema.safeParse("error").success).toBe(false);
});

test("entry arguments follow the launch arguments and quote like the Windows argv rules", () => {
  const line = buildJumpListArguments(LAUNCH, [
    "--open",
    'a "b" c\\',
    "",
  ]);
  expect(line).toBe('"C:\\apps\\main.ts" "--open" "a \\"b\\" c\\\\" ""');
  expect(parseArgumentLine(line)).toEqual([
    "C:\\apps\\main.ts",
    "--open",
    'a "b" c\\',
    "",
  ]);
  expect(entryArguments(LAUNCH, line)).toEqual([
    "--open",
    'a "b" c\\',
    "",
  ]);
  expect(
    buildJumpListArguments(
      {
        ...LAUNCH,
        args: [],
      },
      [],
    ),
  ).toBe("");
});

test("a stored line from another launch command is not this app's entry", () => {
  expect(entryArguments(LAUNCH, '"C:\\other.ts" "--open"')).toBeNull();
  expect(entryArguments(LAUNCH, "")).toBeNull();
  expect(
    entryArguments(
      {
        ...LAUNCH,
        args: [],
      },
      "--open",
    ),
  ).toEqual([
    "--open",
  ]);
});

test("the encoded argument line is bounded and the launch command must be encodable", () => {
  expect(() =>
    buildJumpListArguments(LAUNCH, [
      "x".repeat(2040),
    ]),
  ).toThrow(invalid);
  for (const args of [
    [
      "100%",
    ],
    [
      "a\nb",
    ],
  ]) {
    expect(() =>
      buildJumpListArguments(
        {
          ...LAUNCH,
          args,
        },
        [],
      ),
    ).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED",
      }),
    );
  }
});

test("parsing handles backslashes, tabs and quotes", () => {
  expect(parseArgumentLine('a\tb  "c d"')).toEqual([
    "a",
    "b",
    "c d",
  ]);
  expect(parseArgumentLine('"a\\\\" b')).toEqual([
    "a\\",
    "b",
  ]);
  expect(parseArgumentLine('a\\\\b "c\\"d"')).toEqual([
    "a\\\\b",
    'c"d',
  ]);
  expect(parseArgumentLine("")).toEqual([]);
});
