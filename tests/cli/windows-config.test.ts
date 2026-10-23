import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import type { Policy } from "@bunaway/protocol";
import {
  developmentPolicy,
  developmentWindowHome,
} from "@bunaway/runtime-bun/development";
import { readWindowSpecs } from "@bunaway/runtime-bun/window-config";

const specs = [
  "main",
].map((view) => ({
  view,
  title: view,
  home: `https://app.bunaway.local/${view}.html?mode=1`,
  window: {
    width: 800,
    height: 600,
  },
}));
const policy: Policy = {
  version: 1,
  backend: {
    permissions: [],
  },
  views: specs.map((spec) => ({
    id: spec.view,
    origins: [
      "https://app.bunaway.local",
    ],
    commands: [],
    events: [],
    host: {
      permissions: [],
    },
  })),
};

test("focusability declarations preserve booleans and reject non-boolean native flags", () => {
  const first = specs[0];
  assert(first);
  for (const focusable of [
    true,
    false,
  ]) {
    const spec = {
      ...first,
      window: {
        ...first.window,
        focusable,
      },
    };
    expect(
      readWindowSpecs(
        [
          spec,
        ],
        policy,
      ),
    ).toEqual([
      spec,
    ]);
  }
  for (const focusable of [
    null,
    1,
    "false",
    {},
  ]) {
    expect(() =>
      readWindowSpecs(
        [
          {
            ...first,
            window: {
              ...first.window,
              focusable,
            },
          },
        ],
        policy,
      ),
    ).toThrow("Window focusable must be a boolean");
  }
});

test("initial maximized and fullscreen declarations accept independent booleans without mutation", () => {
  const first = specs[0];
  assert(first);
  for (const maximized of [
    false,
    true,
  ]) {
    for (const fullscreen of [
      false,
      true,
    ]) {
      const spec = {
        ...first,
        visible: false,
        showWhenReady: "sdk" as const,
        window: {
          ...first.window,
          maximized,
          fullscreen,
        },
      };
      expect(
        readWindowSpecs(
          [
            spec,
          ],
          policy,
        ),
      ).toEqual([
        spec,
      ]);
      expect(spec.window).toEqual({
        ...first.window,
        maximized,
        fullscreen,
      });
    }
  }
  for (const field of [
    "maximized",
    "fullscreen",
  ]) {
    for (const value of [
      null,
      1,
      "true",
      {},
    ]) {
      expect(() =>
        readWindowSpecs(
          [
            {
              ...first,
              window: {
                ...first.window,
                [field]: value,
              },
            },
          ],
          policy,
        ),
      ).toThrow(`Window ${field} must be a boolean`);
    }
  }
});

test("window placement declarations validate paired physical coordinates and exclusive center before startup", () => {
  const first = specs[0];
  assert(first);
  for (const placement of [
    {
      x: -1920,
      y: -100,
      useContentSize: false,
      preventOverflow: true,
    },
    {
      x: null,
      y: null,
      center: true,
    },
    {
      center: false,
      useContentSize: true,
      preventOverflow: false,
    },
    {
      x: -2147483648,
      y: 2147483647,
    },
  ]) {
    const spec = {
      ...first,
      window: {
        ...first.window,
        ...placement,
      },
    };
    expect(
      readWindowSpecs(
        [
          spec,
        ],
        policy,
      ),
    ).toEqual([
      spec,
    ]);
  }
  for (const placement of [
    {
      x: 0,
    },
    {
      y: 0,
    },
    {
      x: 0,
      y: null,
    },
    {
      x: 0,
      y: 0,
      center: true,
    },
    {
      x: 0.5,
      y: 0,
    },
    {
      x: 0,
      y: 2147483648,
    },
    {
      x: Number.NaN,
      y: 0,
    },
    {
      center: "true",
    },
    {
      useContentSize: null,
    },
    {
      preventOverflow: 1,
    },
  ]) {
    expect(() =>
      readWindowSpecs(
        [
          {
            ...first,
            startup: false,
            window: {
              ...first.window,
              ...placement,
            },
          },
        ],
        policy,
      ),
    ).toThrow("Window placement");
  }
});

test("window settings require one valid policy-backed window", () => {
  expect(readWindowSpecs(specs, policy)).toEqual(specs);
  for (const invalid of [
    [],
    [
      specs[0],
      specs[0],
    ],
    [
      {
        ...specs[0],
        view: "absent",
      },
    ],
    [
      {
        ...specs[0],
        home: "https://remote.example/main.html",
      },
    ],
    [
      {
        ...specs[0],
        home: "https://app.bunaway.local/main.html#fragment",
      },
    ],
    [
      {
        ...specs[0],
        title: "bad\0title",
      },
    ],
    [
      {
        ...specs[0],
        startup: "false",
      },
    ],
    [
      {
        ...specs[0],
        window: {
          width: 199,
          height: 600,
        },
      },
    ],
    [
      {
        ...specs[0],
        extra: true,
      },
    ],
  ]) {
    expect(() => readWindowSpecs(invalid, policy)).toThrow();
  }
});

test("a deferred startup window keeps its declaration validation", () => {
  const deferred = specs.map((spec) => ({
    ...spec,
    startup: false,
  }));
  expect(readWindowSpecs(deferred, policy)).toEqual(deferred);
  expect(() =>
    readWindowSpecs(
      [
        {
          ...deferred[0],
          home: "https://remote.example/",
        },
      ],
      policy,
    ),
  ).toThrow("allowed app origin");
  // Invalid identifiers must fail before policy lookup, including a trailing newline.
  expect(() =>
    readWindowSpecs(
      [
        {
          ...specs[0],
          view: "main\n",
        },
      ],
      policy,
    ),
  ).toThrow("Window view IDs must contain");
  for (const removed of [
    {
      instances: "single",
    },
    {
      maxInstances: 1,
    },
    {
      profile: "shared",
    },
  ]) {
    expect(() =>
      readWindowSpecs(
        [
          {
            ...specs[0],
            ...removed,
          },
        ],
        policy,
      ),
    ).toThrow("Unknown window configuration field");
  }
});

test("window size constraints accept nullable axes and reject invalid or contradictory bounds", () => {
  const baseSpec = specs[0];
  assert(baseSpec);
  const constrainedSpec = {
    ...baseSpec,
    window: {
      ...baseSpec.window,
      minWidth: 480,
      minHeight: null,
      maxWidth: 1600,
    },
  };
  const constrained = [
    constrainedSpec,
  ];
  expect(readWindowSpecs(constrained, policy)).toEqual(constrained);

  for (const window of [
    {
      ...constrainedSpec.window,
      minWidth: 199,
    },
    {
      ...constrainedSpec.window,
      maxHeight: 4097,
    },
    {
      ...constrainedSpec.window,
      minWidth: 480.5,
    },
    {
      ...constrainedSpec.window,
      minWidth: "480",
    },
    {
      ...constrainedSpec.window,
      minWidth: 500,
      maxWidth: 499,
    },
    {
      ...constrainedSpec.window,
      minHeight: 500,
      maxHeight: 499,
    },
    {
      ...constrainedSpec.window,
      extra: 1,
    },
  ]) {
    expect(() =>
      readWindowSpecs(
        [
          {
            ...constrainedSpec,
            window,
          },
        ],
        policy,
      ),
    ).toThrow();
  }
});

test("development replaces the view origin and preserves the home path and query", () => {
  const server = "http://127.0.0.1:5173/health";
  const devPolicy = developmentPolicy(
    policy,
    specs.map((spec) => spec.view),
    server,
  );
  const devSpecs = specs.map((spec) => ({
    ...spec,
    home: developmentWindowHome(spec.home, server),
  }));
  expect(devSpecs.map((spec) => spec.home)).toEqual([
    "http://127.0.0.1:5173/main.html?mode=1",
  ]);
  expect(readWindowSpecs(devSpecs, devPolicy, server)).toEqual(devSpecs);
  expect(policy.views[0]?.origins).toEqual([
    "https://app.bunaway.local",
  ]);
  expect(() => readWindowSpecs(devSpecs, policy, server)).toThrow();
});

test("backgroundColor declarations are normalized to lowercase #rrggbb and reject other forms", () => {
  const first = specs[0];
  assert(first);
  const declare = (backgroundColor: unknown) =>
    readWindowSpecs(
      [
        {
          ...first,
          window: {
            ...first.window,
            backgroundColor,
          },
        },
      ],
      policy,
    );
  expect(declare("#ABC")[0]?.window.backgroundColor).toBe("#aabbcc");
  expect(declare("#203040")[0]?.window.backgroundColor).toBe("#203040");
  expect(declare(undefined)[0]?.window).not.toHaveProperty("backgroundColor");
  for (const invalid of [
    "#11223344",
    "#1234",
    "112233",
    "#12345g",
    "red",
    "#112233\n",
    1,
    null,
  ]) {
    expect(() => declare(invalid)).toThrow(
      "Window backgroundColor must be #RGB or #RRGGBB.",
    );
  }
});

test("display declarations preserve explicit defaults and reject invalid options", () => {
  const first = specs[0];
  assert(first);
  for (const titlebar of [
    "system",
    "custom",
  ] as const) {
    for (const enabled of [
      true,
      false,
    ]) {
      const input = {
        ...first,
        window: {
          ...first.window,
          titlebar,
          alwaysOnTop: enabled,
          skipTaskbar: enabled,
          contentProtection: enabled,
        },
      };
      expect(
        readWindowSpecs(
          [
            input,
          ],
          policy,
        ),
      ).toEqual([
        input,
      ]);
    }
  }
  for (const option of [
    {
      titlebar: "frameless",
    },
    {
      titlebar: null,
    },
    {
      alwaysOnTop: 1,
    },
    {
      skipTaskbar: "true",
    },
    {
      contentProtection: "true",
    },
  ]) {
    expect(() =>
      readWindowSpecs(
        [
          {
            ...first,
            window: {
              ...first.window,
              ...option,
            },
          },
        ],
        policy,
      ),
    ).toThrow();
  }
});
