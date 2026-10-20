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

const setIcon = "windows.setIcon";
const hasCustomIcon = "windows.hasCustomIcon";
const target = {
  view: "main",
};
const ico = trayIco().toString("base64");
const brokenFrame = trayIco();
brokenFrame.writeUInt16LE(7, 22 + 14);
const brokenFrameIco = brokenFrame.toString("base64");

test("window icon schema takes the tray ICO contract or null and nothing else", () => {
  for (const payload of [
    {
      ...target,
      ico,
    },
    {
      ...target,
      windowId: "id-1",
      ico,
    },
    {
      ...target,
      ico: null,
    },
  ]) {
    expect(
      validateWindowCall({
        operation: setIcon,
        payload,
      }).payload,
    ).toEqual(payload);
  }
  for (const payload of [
    target,
    {
      ...target,
      ico: "C:/icon.ico",
    },
    {
      ...target,
      ico: "",
    },
    {
      // Valid directory with a DIB frame that declares an unsupported bit depth.
      ...target,
      ico: brokenFrameIco,
    },
    {
      ...target,
      ico: "A".repeat(87_388),
    },
    {
      ...target,
      ico,
      description: "x",
    },
  ]) {
    expect(() =>
      validateWindowCall({
        operation: setIcon,
        payload,
      }),
    ).toThrow();
  }
  expect(validateWindowOutput(setIcon, null)).toBeNull();
  expect(() => validateWindowOutput(setIcon, true)).toThrow();
});

test("hasCustomIcon takes a window target and returns a boolean", () => {
  expect(
    validateWindowCall({
      operation: hasCustomIcon,
      payload: target,
    }).payload,
  ).toEqual(target);
  expect(() =>
    validateWindowCall({
      operation: hasCustomIcon,
      payload: {
        ...target,
        ico,
      },
    }),
  ).toThrow();
  expect(validateWindowOutput(hasCustomIcon, false)).toBe(false);
  expect(() => validateWindowOutput(hasCustomIcon, null)).toThrow();
});

test("window icon operations are unsupported on macOS", () => {
  const names = windows._definition.nativePlatforms.macos?.operations ?? [];
  expect(names).not.toContain("setIcon");
  expect(names).not.toContain("hasCustomIcon");
});

function fixture() {
  const calls: unknown[][] = [];
  let closed = false;
  const unused = () => {
    throw new Error("Unexpected native window control");
  };
  const native = {
    getReadiness: unused,
    setIcon: (...args: unknown[]) =>
      calls.push([
        "setIcon",
        ...args,
      ]),
    hasCustomIcon: () => {
      calls.push([
        "hasCustomIcon",
      ]);
      return true;
    },
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
        requestId: "icon",
        permissions: {
          permissions,
        },
      }),
  };
}

test("setIcon forwards an icon provider and clears with null", async () => {
  const f = fixture();
  expect(
    await f.invoke(setIcon, {
      ...target,
      ico,
    }),
  ).toBeNull();
  await f.invoke(setIcon, {
    ...target,
    ico: null,
  });
  // The plugin hands the host a provider instead of the ICO; null returns to the application icon.
  expect(f.calls.map(([, icon]) => typeof icon)).toEqual([
    "function",
    "object",
  ]);
  expect(f.calls[1]?.[1]).toBeNull();
  expect(await f.invoke(hasCustomIcon, target)).toBe(true);
});

test("the icon provider is validated before any native call", async () => {
  const f = fixture();
  await expect(
    f.invoke(setIcon, {
      ...target,
      ico: "AAAA",
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(f.calls).toEqual([]);
});

test("each icon operation requires its own permission, a live target and platform support", async () => {
  const f = fixture();
  const payload = {
    ...target,
    ico,
  };
  await expect(
    f.invoke(setIcon, payload, [
      hasCustomIcon,
    ]),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  await expect(
    f.invoke(hasCustomIcon, target, [
      setIcon,
    ]),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  await expect(
    f.invoke(setIcon, {
      ...payload,
      view: "unknown",
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  expect(f.calls).toEqual([]);
  const adapter = f.native as {
    setIcon?: unknown;
    hasCustomIcon?: unknown;
  };
  adapter.setIcon = undefined;
  adapter.hasCustomIcon = undefined;
  await expect(f.invoke(setIcon, payload)).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  await expect(f.invoke(hasCustomIcon, target)).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  f.close();
  await expect(f.invoke(setIcon, payload)).rejects.toThrow();
});
