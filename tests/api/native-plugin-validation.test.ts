import { expect, test } from "bun:test";
import { defineNativePlugin } from "@bunaway/plugin";
import { z } from "zod";

const schema = z.null();
const declared = {
  input: schema,
  output: schema,
};
const handled = {
  ...declared,
  handler: () => null,
};

/** An object with a single computed key, such as the reserved `then`. */
function keyed(key: string, value: unknown) {
  return {
    [key]: value,
  };
}

/** Declarations are deliberately malformed, so the tests bypass the type checks. */
function define(definition: unknown, calls?: unknown) {
  return defineNativePlugin(definition as never, calls as never);
}

test("lifecycle platforms keep their own operations and expose frozen metadata", () => {
  const plugin = define({
    name: "example",
    platforms: {
      windows: {
        operations: {
          read: handled,
        },
      },
      macos: {
        thread: "ui",
        operations: {
          read: handled,
          write: handled,
        },
      },
    },
  }) as {
    _definition: {
      nativePlatforms: Record<
        string,
        {
          thread: string;
          operations: string[];
          create: unknown;
        }
      >;
      native: {
        operations: {
          name: string;
        }[];
      };
    };
  };
  const { nativePlatforms, native } = plugin._definition;
  expect(nativePlatforms.windows?.thread).toBe("worker");
  expect(nativePlatforms.windows?.operations).toEqual([
    "read",
  ]);
  expect(nativePlatforms.macos?.thread).toBe("ui");
  expect(nativePlatforms.macos?.operations).toEqual([
    "read",
    "write",
  ]);
  expect(typeof nativePlatforms.macos?.create).toBe("function");
  expect(Object.keys(nativePlatforms.macos ?? {})).not.toContain("create");
  expect(native.operations).toEqual([
    {
      name: "example.read",
    },
    {
      name: "example.write",
    },
  ]);
  expect(Object.isFrozen(nativePlatforms.windows)).toBe(true);
});

test("platform declarations reject unknown platforms, execution settings and unknown threads", () => {
  for (const platform of [
    {
      Windows: {
        operations: {},
      },
    },
    {
      windows: {
        execution: "main",
        operations: {
          read: handled,
        },
      },
    },
    {
      windows: {
        thread: "main",
        operations: {
          read: handled,
        },
      },
    },
  ]) {
    expect(() =>
      define({
        name: "example",
        platforms: platform,
      }),
    ).toThrow("Invalid native plugin platform declaration.");
  }
});

test("lifecycle platforms reject bad hooks, operation tables and handlers", () => {
  for (const [platform, message] of [
    [
      {
        initialize: 1,
        operations: {
          read: handled,
        },
      },
      "Invalid native platform lifecycle.",
    ],
    [
      {
        dispose: "x",
        operations: {
          read: handled,
        },
      },
      "Invalid native platform lifecycle.",
    ],
    [
      {
        busy: {},
        operations: {
          read: handled,
        },
      },
      "Invalid native platform lifecycle.",
    ],
    [
      {},
      "Invalid native platform lifecycle.",
    ],
    [
      {
        operations: [],
      },
      "Invalid native platform lifecycle.",
    ],
    [
      {
        operations: {
          read: declared,
        },
      },
      "Invalid native operation handler.",
    ],
    [
      {
        operations: {
          read: null,
        },
      },
      "Plugin inputs and outputs must be Zod schemas.",
    ],
    [
      {
        operations: {
          read: {
            ...handled,
            handlers: {},
          },
        },
      },
      "Declare native handlers inside platform operations.",
    ],
    [
      {
        operations: keyed("then", handled),
      },
      "Reserved native plugin operation name: then.",
    ],
  ] as const) {
    expect(() =>
      define({
        name: "example",
        platforms: {
          windows: platform,
        },
      }),
    ).toThrow(message);
  }
});

test("factory platforms need an adapter factory, legacy schemas and consistent operation support", () => {
  const create = () => ({});
  const withOperations = Object.assign(() => ({}), {
    operations: [
      "read",
    ],
  });
  const legacy = (
    platform: unknown,
    operations: unknown = {
      read: declared,
    },
  ) =>
    define({
      name: "example",
      operations,
      platforms: {
        windows: platform,
      },
    });
  expect(() =>
    legacy({
      create: 5,
    }),
  ).toThrow("Native plugin platforms require an adapter factory.");
  expect(() =>
    define({
      name: "example",
      platforms: {
        windows: {
          create,
        },
      },
    }),
  ).toThrow("Native handlers require a lifecycle platform.");
  expect(() =>
    legacy({
      create,
      initialize() {},
    }),
  ).toThrow("Native handlers require a lifecycle platform.");
  expect(() =>
    legacy({
      create: withOperations,
      operations: [
        "read",
      ],
    }),
  ).toThrow("Handler maps infer support; omit the platform operations list.");
  for (const operations of [
    [
      "read",
      "read",
    ],
    [
      "missing",
    ],
    [
      1,
    ],
    "read",
  ]) {
    expect(() =>
      legacy({
        create,
        operations,
      }),
    ).toThrow("Invalid native plugin operation support.");
  }
  const plugin = legacy({
    create,
    operations: [
      "read",
    ],
  }) as {
    _definition: {
      nativePlatforms: Record<
        string,
        {
          operations: string[];
        }
      >;
    };
  };
  expect(plugin._definition.nativePlatforms.windows?.operations).toEqual([
    "read",
  ]);
  expect(() =>
    define({
      name: "example",
      operations: {
        read: declared,
      },
      platforms: {
        windows: {
          operations: {
            read: handled,
          },
        },
      },
    }),
  ).toThrow("Invalid native platform lifecycle.");
});

test("the calls mapping must return an extensible API without reserved properties", () => {
  const platforms = {
    windows: {
      operations: {
        read: handled,
      },
    },
  };
  for (const api of [
    null,
    1,
    keyed("then", () => {}),
    {
      toJSON() {},
    },
    {
      _definition: 1,
    },
    Object.freeze({}),
  ]) {
    expect(() =>
      define(
        {
          name: "example",
          platforms,
        },
        () => api,
      ),
    ).toThrow("without reserved properties");
  }
  const plugin = define(
    {
      name: "example",
      platforms,
    },
    (operations: Record<string, unknown>) => ({
      load: operations.read,
    }),
  ) as Record<string, unknown>;
  expect(typeof plugin.load).toBe("function");
  expect(Object.keys(plugin)).toEqual([
    "load",
  ]);
});
