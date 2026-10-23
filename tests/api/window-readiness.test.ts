import { expect, test } from "bun:test";
import type { Policy } from "@bunaway/protocol";
import { readWindowSpecs } from "@bunaway/runtime-bun/window-config";

const policy: Policy = {
  version: 1,
  backend: {
    permissions: [],
  },
  views: [
    "main",
  ].map((id) => ({
    id,
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
const specs = policy.views.map((view) => ({
  view: view.id,
  home: "https://app.bunaway.local/index.html",
  title: view.id,
  window: {
    width: 800,
    height: 600,
  },
}));

test("window configuration validates and preserves hidden and preparation display options", () => {
  expect(
    readWindowSpecs(
      [
        {
          ...specs[0],
          visible: false,
          showWhenReady: "sdk",
        },
      ],
      policy,
    )[0],
  ).toMatchObject({
    visible: false,
    showWhenReady: "sdk",
  });
  expect(
    readWindowSpecs(
      [
        {
          ...specs[0],
          showWhenReady: "document",
        },
      ],
      policy,
    )[0]?.showWhenReady,
  ).toBe("document");
  for (const input of [
    {
      visible: "false",
    },
    {
      showWhenReady: true,
    },
    {
      showWhenReady: "app",
    },
  ]) {
    expect(() =>
      readWindowSpecs(
        [
          {
            ...specs[0],
            ...input,
          },
        ],
        policy,
      ),
    ).toThrow();
  }
});
