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
import { trayIco } from "../fixtures/tray-icon.ts";

const operation = "windows.setOverlayIcon";
const target = {
  view: "main",
};
const ico = trayIco().toString("base64");
const brokenFrame = trayIco();
brokenFrame.writeUInt16LE(7, 22 + 14);
const brokenFrameIco = brokenFrame.toString("base64");

test("overlay icon schema takes the tray ICO contract and a description with window title limits", () => {
  for (const payload of [
    {
      ...target,
      ico,
      description: "3 unread",
    },
    {
      ...target,
      windowId: "id-1",
      ico,
      description: "",
    },
    {
      ...target,
      ico: null,
      description: "ignored",
    },
    {
      ...target,
      ico,
      description: "a".repeat(1024),
    },
  ]) {
    expect(
      validateWindowCall({
        operation,
        payload,
      }).payload,
    ).toEqual(payload);
  }
  for (const payload of [
    target,
    {
      ...target,
      ico,
    },
    {
      ...target,
      description: "x",
    },
    {
      ...target,
      ico: "C:/icon.ico",
      description: "x",
    },
    {
      ...target,
      ico: "",
      description: "x",
    },
    {
      // Valid directory with a DIB frame that declares an unsupported bit depth.
      ...target,
      ico: brokenFrameIco,
      description: "x",
    },
    {
      ...target,
      ico: "A".repeat(87_388),
      description: "x",
    },
    {
      ...target,
      ico,
      description: "a".repeat(1025),
    },
    {
      ...target,
      ico,
      description: "a\0b",
    },
    {
      ...target,
      ico,
      description: "😀".repeat(513),
    },
    {
      ...target,
      ico,
      description: 1,
    },
    {
      ...target,
      ico,
      description: "x",
      extra: 1,
    },
  ]) {
    expect(() =>
      validateWindowCall({
        operation,
        payload,
      }),
    ).toThrow();
  }
  expect(validateWindowOutput(operation, null)).toBeNull();
  expect(() => validateWindowOutput(operation, true)).toThrow();
});

test("overlay icon is unsupported on macOS", () => {
  const names = windows._definition.nativePlatforms.macos?.operations ?? [];
  expect(names).not.toContain("setOverlayIcon");
});

function fixture() {
  const calls: unknown[][] = [];
  let closed = false;
  const unused = () => {
    throw new Error("Unexpected native window control");
  };
  const native = {
    getReadiness: unused,
    setOverlayIcon: (...args: unknown[]) => calls.push(args),
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
    calls,
    close: () => {
      closed = true;
    },
    invoke: (
      name: string,
      payload: JsonValue,
      permissions: string[] = [
        name,
      ],
    ) =>
      execute(name, payload, "backend", {
        requestId: "overlay",
        permissions: {
          permissions,
        },
      }),
  };
}

test("overlay icon dispatch forwards an icon provider and description and removes with null", async () => {
  const f = fixture();
  expect(
    await f.invoke(operation, {
      ...target,
      ico,
      description: "3 unread",
    }),
  ).toBeNull();
  await f.invoke(operation, {
    ...target,
    ico: null,
    description: "ignored",
  });
  // The plugin hands the host an icon provider instead of the ICO; null removes the overlay.
  expect(
    f.calls.map(([icon, description]) => [
      typeof icon,
      description,
    ]),
  ).toEqual([
    [
      "function",
      "3 unread",
    ],
    [
      "object",
      "ignored",
    ],
  ]);
  expect(f.calls[1]?.[0]).toBeNull();
});

test("overlay icon dispatch requires its own permission, a live target and platform support", async () => {
  const f = fixture();
  const payload = {
    ...target,
    ico,
    description: "x",
  };
  await expect(
    f.invoke(operation, payload, [
      "windows.setThumbnailToolTip",
    ]),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  await expect(
    f.invoke(operation, {
      ...payload,
      view: "unknown",
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(f.calls).toEqual([]);
  delete (
    f.native as {
      setOverlayIcon?: unknown;
    }
  ).setOverlayIcon;
  await expect(f.invoke(operation, payload)).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  f.close();
  await expect(f.invoke(operation, payload)).rejects.toThrow();
});
