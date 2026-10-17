import { expect, test } from "bun:test";
import type {
  NativeWindow,
  NativeWindowServices,
} from "@bunaway/plugin-api/native";
import windows, {
  validateWindowCall,
  validateWindowOutput,
} from "@bunaway/plugin-windows";
import type { JsonValue } from "@bunaway/protocol";
import { createOperations } from "#plugins/windows/src/platforms/windows";

const clipOperation = "windows.setThumbnailClip";
const toolTipOperation = "windows.setThumbnailToolTip";
const target = {
  view: "main",
};
const region = {
  x: 4,
  y: 8,
  width: 120,
  height: 60,
};

test("thumbnail clip schema requires a positive in-range integer region or null", () => {
  for (const payload of [
    {
      ...target,
      region,
    },
    {
      ...target,
      windowId: "id-1",
      region: null,
    },
    {
      ...target,
      region: {
        ...region,
        x: 0,
        y: 0,
      },
    },
  ]) {
    expect(
      validateWindowCall({
        operation: clipOperation,
        payload,
      }).payload,
    ).toEqual(payload);
  }
  for (const payload of [
    target,
    {
      ...target,
      region: {
        ...region,
        width: 0,
      },
    },
    {
      ...target,
      region: {
        ...region,
        height: -1,
      },
    },
    {
      ...target,
      region: {
        ...region,
        x: -1,
      },
    },
    {
      ...target,
      region: {
        ...region,
        y: 0.5,
      },
    },
    {
      ...target,
      region: {
        ...region,
        extra: 1,
      },
    },
    {
      ...target,
      region: {
        x: 0,
        y: 0,
        width: 1,
      },
    },
  ]) {
    expect(() =>
      validateWindowCall({
        operation: clipOperation,
        payload,
      }),
    ).toThrow();
  }
  expect(validateWindowOutput(clipOperation, null)).toBeNull();
  expect(() => validateWindowOutput(clipOperation, true)).toThrow();
});

test("thumbnail tooltip schema follows window title limits and allows clearing", () => {
  for (const toolTip of [
    "Report",
    "",
    null,
    "a".repeat(1024),
  ]) {
    expect(
      validateWindowCall({
        operation: toolTipOperation,
        payload: {
          ...target,
          toolTip,
        },
      }).payload,
    ).toEqual({
      ...target,
      toolTip,
    });
  }
  for (const payload of [
    target,
    {
      ...target,
      toolTip: "a".repeat(1025),
    },
    {
      ...target,
      toolTip: "a\0b",
    },
    {
      ...target,
      toolTip: "😀".repeat(513),
    },
    {
      ...target,
      toolTip: 1,
    },
  ]) {
    expect(() =>
      validateWindowCall({
        operation: toolTipOperation,
        payload,
      }),
    ).toThrow();
  }
  expect(validateWindowOutput(toolTipOperation, null)).toBeNull();
});

test("thumbnail operations are unsupported on macOS", () => {
  const names = windows._definition.nativePlatforms.macos?.operations ?? [];
  expect(names).not.toContain("setThumbnailClip");
  expect(names).not.toContain("setThumbnailToolTip");
});

function fixture() {
  const clips: unknown[] = [];
  const toolTips: unknown[] = [];
  let closed = false;
  const unused = () => {
    throw new Error("Unexpected native window control");
  };
  const native = {
    getReadiness: unused,
    setThumbnailClip: (value: unknown) => clips.push(value),
    setThumbnailToolTip: (value: unknown) => toolTips.push(value),
  } as unknown as NativeWindow;
  const services = {
    specs: [
      {
        view: "main",
        title: "Main",
        home: "https://app.bunaway.local",
        window: {
          width: 800,
          height: 600,
        },
      },
    ],
    read: () => ({
      closed,
      cleaned: false,
      ready: true,
      failure: null,
      deadline: Infinity,
    }),
    create: unused,
    close: unused,
    window: () => native,
    stopping: () => false,
    cancelled: () => false,
    now: Date.now,
    tick: async () => {},
  } as unknown as NativeWindowServices;
  const execute = createOperations({
    windows: services,
    dataRoot: ".",
    capabilities: [],
  }).executeUI;
  if (!execute) {
    throw new Error("Missing window UI adapter");
  }
  return {
    native,
    clips,
    toolTips,
    close: () => {
      closed = true;
    },
    invoke: (
      operation: string,
      payload: JsonValue,
      permissions: string[] = [
        operation,
      ],
    ) =>
      execute(operation, payload, "backend", {
        requestId: "thumbnail",
        permissions: {
          permissions,
        },
      }),
  };
}

test("thumbnail dispatch forwards regions, clears with null and normalizes empty tooltips", async () => {
  const f = fixture();
  expect(
    await f.invoke(clipOperation, {
      ...target,
      region,
    }),
  ).toBeNull();
  expect(
    await f.invoke(clipOperation, {
      ...target,
      region: null,
    }),
  ).toBeNull();
  expect(f.clips).toEqual([
    region,
    null,
  ]);
  for (const toolTip of [
    "Report",
    "",
    null,
  ]) {
    await f.invoke(toolTipOperation, {
      ...target,
      toolTip,
    });
  }
  expect(f.toolTips).toEqual([
    "Report",
    null,
    null,
  ]);
});

test("thumbnail dispatch keeps independent authority, live targets and platform failures", async () => {
  const f = fixture();
  const clip = {
    ...target,
    region,
  };
  await expect(
    f.invoke(clipOperation, clip, [
      toolTipOperation,
    ]),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  await expect(
    f.invoke(
      toolTipOperation,
      {
        ...target,
        toolTip: "x",
      },
      [
        clipOperation,
      ],
    ),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  await expect(
    f.invoke(clipOperation, {
      view: "unknown",
      region,
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  const mutable = f.native as {
    setThumbnailClip?: unknown;
    setThumbnailToolTip?: unknown;
  };
  delete mutable.setThumbnailClip;
  delete mutable.setThumbnailToolTip;
  await expect(f.invoke(clipOperation, clip)).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  await expect(
    f.invoke(toolTipOperation, {
      ...target,
      toolTip: "x",
    }),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  f.close();
  await expect(f.invoke(clipOperation, clip)).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(f.clips).toEqual([]);
  expect(f.toolTips).toEqual([]);
});
