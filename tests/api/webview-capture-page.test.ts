import { expect, test } from "bun:test";
import type {
  NativePageCapture,
  NativePageCaptureOptions,
  NativeWindow,
  NativeWindowServices,
} from "@bunaway/plugin-api/native";
import windows, { validateWindowCall } from "@bunaway/plugin-windows";
import { type JsonValue, NativeRegistry } from "@bunaway/protocol";
import { windowDefinitions } from "#plugins/windows/src/contract";
import { createOperations } from "#plugins/windows/src/platforms/windows";

const IMAGE: NativePageCapture = {
  mime: "image/png",
  data: "iVBORw0KGgo=",
  width: 3,
  height: 2,
};

function fixture() {
  const requests: NativePageCaptureOptions[] = [];
  const unused = (): never => {
    throw new Error("Unrelated native control used");
  };
  const native: NativeWindow = {
    capturePage: async (options) => {
      requests.push(options);
      return IMAGE;
    },
    getSnapshot: unused,
    getReadiness: unused,
    show: unused,
    showInactive: unused,
    focus: unused,
    activate: unused,
    close: unused,
    minimize: unused,
    maximize: unused,
    unmaximize: unused,
    restore: unused,
    toggleMaximize: unused,
    isMinimized: unused,
    isMaximized: unused,
    isFullscreen: unused,
    getBounds: unused,
    getDpi: unused,
    isVisible: unused,
    isFocused: unused,
    getSizeConstraints: unused,
    setSizeConstraints: unused,
    setSize: unused,
    setPosition: unused,
    setGeometry: unused,
    setFullscreen: unused,
    setCloseConfirmation: unused,
  };

  let closed = false;
  const services: NativeWindowServices = {
    specs: [
      {
        view: "main",
        home: "https://app.bunaway.local/index.html",
        title: "main",
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
      failure: undefined,
      deadline: Infinity,
    }),
    create: unused,
    close: unused,
    window: () => native,
    stopping: () => false,
    cancelled: () => false,
    now: Date.now,
    tick: async () => {},
  };
  const adapter = createOperations({
    dataRoot: ".",
    capabilities: [],
    windows: services,
  });
  const permissions = {
    permissions: [
      "windows.capturePage",
    ],
  };
  const invoke = (payload: JsonValue = {}) => {
    if (!adapter.executeUI) {
      throw new Error("Missing UI adapter");
    }
    return adapter.executeUI("windows.capturePage", payload, "backend", {
      requestId: "capture-test",
      permissions,
    });
  };
  return {
    requests,
    native,
    permissions,
    invoke,
    close: () => {
      closed = true;
    },
  };
}

test("page capture has its own operation and a strict, bounded input", () => {
  const registry = new NativeRegistry([
    windows._definition,
  ]);
  expect(registry.operation("windows.capturePage").name).toBe(
    "windows.capturePage",
  );
  const region = {
    x: 0,
    y: 0,
    width: 10,
    height: 10,
  };
  for (const payload of [
    {
      format: "webp",
    },
    {
      path: "C:\\page.png",
    },
    {
      quality: 50,
    },
    {
      region: {
        ...region,
        width: 0,
      },
    },
    {
      region: {
        ...region,
        x: -1,
      },
    },
    {
      region: {
        ...region,
        height: 16_385,
      },
    },
    {
      region: {
        ...region,
        y: 0.5,
      },
    },
    {
      region: null,
    },
  ]) {
    expect(() =>
      validateWindowCall({
        operation: "windows.capturePage",
        payload,
      }),
    ).toThrow();
  }
  expect(() =>
    validateWindowCall({
      operation: "windows.capturePage",
      payload: {
        format: "jpeg",
        region,
      },
    }),
  ).not.toThrow();
});

test("page capture defaults to the whole page as png and passes explicit options", async () => {
  const f = fixture();
  expect(await f.invoke()).toEqual(IMAGE);
  await f.invoke({
    format: "jpeg",
    region: {
      x: 4,
      y: 5,
      width: 6,
      height: 7,
    },
  });
  expect(f.requests).toEqual([
    {
      format: "png",
      region: null,
    },
    {
      format: "jpeg",
      region: {
        x: 4,
        y: 5,
        width: 6,
        height: 7,
      },
    },
  ]);
});

test("a native failure reaches the caller and the output contract rejects a malformed image", async () => {
  const failing = fixture();
  failing.native.capturePage = async () => {
    throw Object.assign(new Error("busy"), {
      code: "BUSY",
    });
  };
  await expect(failing.invoke()).rejects.toMatchObject({
    code: "BUSY",
  });
  const { output } = windowDefinitions.capturePage;
  expect(output.safeParse(IMAGE).success).toBe(true);
  for (const image of [
    {
      ...IMAGE,
      data: "not base64!",
    },
    {
      ...IMAGE,
      mime: "image/gif",
    },
    {
      ...IMAGE,
      width: 0,
    },
  ]) {
    expect(output.safeParse(image).success).toBe(false);
  }
});

test("permission, closed targets and missing services block page capture", async () => {
  const denied = fixture();
  denied.permissions.permissions = [];
  await expect(denied.invoke()).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  expect(denied.requests).toEqual([]);
  const closed = fixture();
  closed.close();
  await expect(closed.invoke()).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  const unsupported = fixture();
  delete unsupported.native.capturePage;
  await expect(unsupported.invoke()).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
});
