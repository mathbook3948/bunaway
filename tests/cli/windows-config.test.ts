import { expect, test } from "bun:test";
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
    [],
    [
      ...specs,
      specs[0],
    ],
    specs.map((spec) => ({
      ...spec,
      startup: false,
    })),
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
