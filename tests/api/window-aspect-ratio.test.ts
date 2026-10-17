import { expect, test } from "bun:test";
import type {
  NativeWindow,
  NativeWindowServices,
} from "@bunaway/plugin-api/native";
import {
  validateWindowCall,
  validateWindowOutput,
} from "@bunaway/plugin-windows";
import type { Policy } from "@bunaway/protocol";
import { createOperations } from "#plugins/windows/src/platforms/windows";
import { windowPermissions } from "../fixtures/window-permissions.ts";

function fixture(supported = true) {
  let locked: number | null = null;
  // Only the aspect ratio members are exercised; the adapter does not touch the rest.
  const native = (supported
    ? {
        setAspectRatio(ratio: number | null) {
          locked = ratio;
        },
        getAspectRatio: () => locked,
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
    permissions,
    invoke: (
      name: "setAspectRatio" | "getAspectRatio",
      payload: {
        ratio?: number | null;
      } = {},
    ) =>
      Promise.resolve().then(() =>
        execute(
          `windows.${name}`,
          {
            view: "main",
            ...payload,
          },
          "backend",
          {
            requestId: name,
            permissions,
          },
        ),
      ),
  };
}

test("aspect ratio schemas accept null or a finite ratio in range and reject everything else", () => {
  for (const ratio of [
    null,
    0.1,
    1,
    16 / 9,
    10,
  ]) {
    expect(
      validateWindowCall({
        operation: "windows.setAspectRatio",
        payload: {
          view: "main",
          ratio,
        },
      }).operation,
    ).toBe("windows.setAspectRatio");
    expect(validateWindowOutput("windows.getAspectRatio", ratio)).toBe(ratio);
  }
  for (const payload of [
    {},
    {
      ratio: 0,
    },
    {
      ratio: -1,
    },
    {
      ratio: 0.09,
    },
    {
      ratio: 10.1,
    },
    {
      ratio: Number.NaN,
    },
    {
      ratio: Number.POSITIVE_INFINITY,
    },
    {
      ratio: "16:9",
    },
    {
      ratio: 1,
      extra: true,
    },
  ]) {
    expect(() =>
      validateWindowCall({
        operation: "windows.setAspectRatio",
        payload: {
          view: "main",
          ...payload,
        },
      }),
    ).toThrow();
  }
  expect(validateWindowOutput("windows.setAspectRatio", null)).toBeNull();
  expect(() => validateWindowOutput("windows.getAspectRatio", 0)).toThrow();
  expect(() => validateWindowOutput("windows.setAspectRatio", 1)).toThrow();
});

test("aspect ratio is stored per window, released with null and gated by per-operation grants", async () => {
  const f = fixture();
  expect(await f.invoke("getAspectRatio")).toBeNull();
  expect(
    await f.invoke("setAspectRatio", {
      ratio: 4 / 3,
    }),
  ).toBeNull();
  expect(await f.invoke("getAspectRatio")).toBe(4 / 3);
  expect(
    await f.invoke("setAspectRatio", {
      ratio: null,
    }),
  ).toBeNull();
  expect(await f.invoke("getAspectRatio")).toBeNull();

  f.permissions.permissions = [
    "windows.getAspectRatio",
  ];
  await expect(
    f.invoke("setAspectRatio", {
      ratio: 1,
    }),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  f.permissions.permissions = [
    "windows.setAspectRatio",
  ];
  await expect(f.invoke("getAspectRatio")).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
});

test("aspect ratio operations are UNSUPPORTED on platforms without native support", async () => {
  const f = fixture(false);
  await expect(
    f.invoke("setAspectRatio", {
      ratio: 1,
    }),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  await expect(f.invoke("getAspectRatio")).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
});
