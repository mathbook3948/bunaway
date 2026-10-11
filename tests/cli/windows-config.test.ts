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
  "editor",
].map((view) => ({
  view,
  title: view,
  home: `https://app.bunaway.local/${view}.html?mode=1`,
  window: {
    width: 800,
    height: 600,
  },
  ...(view === "editor"
    ? {
        startup: false,
      }
    : {}),
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

test("window settings preserve deferred startup and require unique policy-backed views", () => {
  expect(readWindowSpecs(specs, policy)).toEqual(specs);
  for (const invalid of [
    [
      ...specs,
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

test("window catalogs accept an empty or fully deferred Windows start without weakening declaration validation", () => {
  expect(readWindowSpecs([], policy)).toEqual([]);
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
  expect(() =>
    readWindowSpecs(
      Array.from(
        {
          length: 129,
        },
        () => specs[0],
      ),
      policy,
    ),
  ).toThrow("0 and 128");
});

test("one-window-per-view declarations reject duplicates even when deferred or hidden", () => {
  for (const overrides of [
    {},
    {
      startup: false,
    },
    {
      visible: false,
    },
  ]) {
    expect(() =>
      readWindowSpecs(
        [
          specs[0],
          {
            ...specs[0],
            ...overrides,
          },
        ],
        policy,
      ),
    ).toThrow("Only one window declaration per view is supported");
  }
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
});

test("the window catalog limit includes deferred definitions and accepts 128 distinct views", () => {
  const baseSpec = specs[0];
  const basePolicy = policy.views[0];
  assert(baseSpec && basePolicy);
  const catalog = Array.from(
    {
      length: 128,
    },
    (_, index) => ({
      ...baseSpec,
      view: `view-${index}`,
      startup: false,
    }),
  );
  const catalogPolicy: Policy = {
    ...policy,
    views: catalog.map((spec) => ({
      ...basePolicy,
      id: spec.view,
    })),
  };
  expect(readWindowSpecs(catalog, catalogPolicy)).toEqual(catalog);
  expect(() =>
    readWindowSpecs(
      [
        ...catalog,
        {
          ...baseSpec,
          view: "overflow",
        },
      ],
      catalogPolicy,
    ),
  ).toThrow("0 and 128");
});

test("window size constraints accept nullable axes and reject invalid or contradictory bounds", () => {
  const constrained = [
    {
      ...specs[0]!,
      window: {
        ...specs[0]!.window,
        minWidth: 480,
        minHeight: null,
        maxWidth: 1600,
      },
    },
  ];
  expect(readWindowSpecs(constrained, policy)).toEqual(constrained);

  for (const window of [
    {
      ...constrained[0]!.window,
      minWidth: 199,
    },
    {
      ...constrained[0]!.window,
      maxHeight: 4097,
    },
    {
      ...constrained[0]!.window,
      minWidth: 480.5,
    },
    {
      ...constrained[0]!.window,
      minWidth: "480",
    },
    {
      ...constrained[0]!.window,
      minWidth: 500,
      maxWidth: 499,
    },
    {
      ...constrained[0]!.window,
      minHeight: 500,
      maxHeight: 499,
    },
    {
      ...constrained[0]!.window,
      extra: 1,
    },
  ]) {
    expect(() =>
      readWindowSpecs(
        [
          {
            ...constrained[0]!,
            window,
          },
        ],
        policy,
      ),
    ).toThrow();
  }
});

test("multi-window development replaces each view origin and preserves each home path and query", () => {
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
    "http://127.0.0.1:5173/editor.html?mode=1",
  ]);
  expect(readWindowSpecs(devSpecs, devPolicy, server)).toEqual(devSpecs);
  expect(policy.views[0]?.origins).toEqual([
    "https://app.bunaway.local",
  ]);
  expect(() => readWindowSpecs(devSpecs, policy, server)).toThrow();
});

test("instance configuration validates multiplicity, explicit bounds and fixed profile selection", () => {
  const first = specs[0];
  assert(first);
  expect(
    readWindowSpecs(
      [
        {
          ...first,
          instances: "multiple",
          maxInstances: 128,
          profile: "isolated",
        },
      ],
      policy,
    )[0],
  ).toMatchObject({
    instances: "multiple",
    maxInstances: 128,
    profile: "isolated",
  });
  expect(
    readWindowSpecs(
      [
        {
          ...first,
          instances: "single",
          maxInstances: 1,
          profile: "shared",
        },
      ],
      policy,
    )[0],
  ).toMatchObject({
    instances: "single",
    maxInstances: 1,
  });
  for (const extra of [
    {
      instances: "many",
    },
    {
      instances: "multiple",
    },
    {
      maxInstances: 2,
    },
    {
      instances: "multiple",
      maxInstances: 0,
    },
    {
      instances: "multiple",
      maxInstances: 129,
    },
    {
      instances: "multiple",
      maxInstances: 1.5,
    },
    {
      instances: "multiple",
      maxInstances: "2",
    },
    {
      profile: "custom",
    },
  ]) {
    expect(() =>
      readWindowSpecs(
        [
          {
            ...first,
            ...extra,
          },
        ],
        policy,
      ),
    ).toThrow();
  }
});
