import { expect, test } from "bun:test";
import type {
  NativeWindow,
  NativeWindowServices,
  WindowResizeDirection,
} from "@bunaway/plugin-api/native";
import {
  validateWindowCall,
  validateWindowOutput,
} from "@bunaway/plugin-windows";
import type { JsonValue, Policy } from "@bunaway/protocol";
import { createOperations } from "#plugins/windows/src/platforms/windows";
import { windowPermissions } from "../fixtures/window-permissions.ts";

const DIRECTIONS: WindowResizeDirection[] = [
  "north",
  "south",
  "east",
  "west",
  "northEast",
  "northWest",
  "southEast",
  "southWest",
];

function fixture(supported = true) {
  const calls: Array<
    [
      string,
      unknown[],
    ]
  > = [];
  // Only the drag members are exercised; the adapter does not touch the rest.
  const native = (supported
    ? {
        startDragging() {
          calls.push([
            "startDragging",
            [],
          ]);
        },
        startResizeDragging(direction: WindowResizeDirection) {
          calls.push([
            "startResizeDragging",
            [
              direction,
            ],
          ]);
        },
      }
    : {}) as unknown as NativeWindow;
  const services: NativeWindowServices = {
    specs: [
      {
        view: "main",
        title: "main",
        home: "https://app.bunaway.local",
        window: {
          width: 800,
          height: 600,
        },
      },
    ],
    read: () => ({
      closed: false,
      cleaned: false,
      ready: true,
      failure: null,
      deadline: Infinity,
    }),
    create() {},
    close: () => true,
    window: () => native,
    stopping: () => false,
    cancelled: () => false,
    now: Date.now,
    tick: async () => {},
  };
  const permissions: Policy["backend"] = {
    permissions: windowPermissions(),
  };
  const execute = createOperations({
    dataRoot: ".",
    capabilities: [],
    windows: services,
  }).executeUI;
  if (!execute) {
    throw new Error("Missing UI adapter.");
  }
  return {
    calls,
    permissions,
    invoke: (
      name: "startDragging" | "startResizeDragging",
      payload: Record<string, unknown> | null = null,
    ) =>
      Promise.resolve().then(() =>
        execute(`windows.${name}`, payload as JsonValue, "backend", {
          requestId: name,
          permissions,
        }),
      ),
  };
}

test("drag schemas take a target window and a closed set of resize directions", () => {
  expect(
    validateWindowCall({
      operation: "windows.startDragging",
      payload: null,
    }).operation,
  ).toBe("windows.startDragging");
  for (const direction of DIRECTIONS) {
    expect(
      validateWindowCall({
        operation: "windows.startResizeDragging",
        payload: {
          direction,
        },
      }).operation,
    ).toBe("windows.startResizeDragging");
  }
  for (const payload of [
    {},
    {
      direction: "North",
    },
    {
      direction: "up",
    },
    {
      direction: 12,
    },
    {
      direction: "north",
      extra: true,
    },
  ]) {
    expect(() =>
      validateWindowCall({
        operation: "windows.startResizeDragging",
        payload: {
          ...payload,
        },
      }),
    ).toThrow();
  }
  expect(() =>
    validateWindowCall({
      operation: "windows.startDragging",
      payload: {
        direction: "north",
      },
    }),
  ).toThrow();
  expect(validateWindowOutput("windows.startDragging", null)).toBeNull();
  expect(validateWindowOutput("windows.startResizeDragging", null)).toBeNull();
  expect(() => validateWindowOutput("windows.startDragging", true)).toThrow();
});

test("drag operations reach the native window and are gated by per-operation grants", async () => {
  const f = fixture();
  expect(await f.invoke("startDragging")).toBeNull();
  for (const direction of DIRECTIONS) {
    expect(
      await f.invoke("startResizeDragging", {
        direction,
      }),
    ).toBeNull();
  }
  expect(f.calls).toEqual([
    [
      "startDragging",
      [],
    ],
    ...DIRECTIONS.map(
      (direction) =>
        [
          "startResizeDragging",
          [
            direction,
          ],
        ] as [
          string,
          unknown[],
        ],
    ),
  ]);

  f.calls.length = 0;
  f.permissions.permissions = [
    "windows.startResizeDragging",
  ];
  await expect(f.invoke("startDragging")).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  f.permissions.permissions = [
    "windows.startDragging",
  ];
  await expect(
    f.invoke("startResizeDragging", {
      direction: "east",
    }),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  expect(f.calls).toEqual([]);
});

test("drag operations are UNSUPPORTED on platforms without native support", async () => {
  const f = fixture(false);
  await expect(f.invoke("startDragging")).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  await expect(
    f.invoke("startResizeDragging", {
      direction: "south",
    }),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
});
