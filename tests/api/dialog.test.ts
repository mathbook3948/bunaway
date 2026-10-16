import { expect, test } from "bun:test";
import { defineNativePlugin, type NativeEnvironment } from "@bunaway/plugin";
import type { NativeDialogServices } from "@bunaway/plugin-api/native";
import dialog from "@bunaway/plugin-dialog";
import {
  BunawayError,
  type JsonValue,
  NativeRegistry,
} from "@bunaway/protocol";
import { dialogOperations } from "#plugins/dialog/src/operations";
import {
  type DialogFactory,
  WindowsDialogs,
} from "#plugins/dialog/src/platforms/windows";
import { DialogCloseRequest } from "#plugins/dialog/src/platforms/windows-bindings";
import { nativeFactory } from "../fixtures/native-platform.ts";

function fixture(
  create: DialogFactory = () => ({
    show: () => ({
      cancelled: true,
    }),
    dispose() {},
  }),
) {
  let stopping = false;
  let alive = true;
  let polls = 0;
  const services: NativeDialogServices = {
    watchCancellation: () => ({
      cancelled: () => false,
      dispose() {},
    }),
    createWindow: () => 12n,
    destroyWindow() {},
    origin: (requestId) =>
      requestId === "request"
        ? {
            windowId: "owner",
            viewId: "main",
          }
        : null,
    owner: (windowId) =>
      windowId === "owner"
        ? {
            hwnd: 42n,
            alive: () => alive,
          }
        : null,
    stopping: () => stopping,
    poll: () => {
      polls++;
    },
  };
  const definition = defineNativePlugin({
    name: "dialog",
    platforms: {
      windows: {
        thread: "ui",
        initialize: (environment: NativeEnvironment) =>
          new WindowsDialogs(environment.dialogs, create),
        dispose: (instance: WindowsDialogs) => instance.dispose(),
        busy: (instance: WindowsDialogs) => instance.busy(),
        operations: dialogOperations,
      },
    },
  });
  const adapter = nativeFactory(
    definition,
    "windows",
  )({
    dataRoot: "unused",
    capabilities: [],
    dialogs: services,
  });
  const invoke = (
    name: keyof typeof dialogOperations,
    input: JsonValue = {},
    source = "backend",
    signal?: AbortSignal,
    permissions = [
      `dialog.${name}`,
    ],
  ) => {
    if (!adapter.executeUI) {
      throw new Error("Missing UI adapter");
    }
    return adapter.executeUI(`dialog.${name}`, input, source, {
      requestId: "request",
      permissions: {
        permissions,
      },
      ...(signal
        ? {
            signal,
          }
        : {}),
    });
  };
  return {
    services,
    adapter,
    invoke,
    stop: () => {
      stopping = true;
    },
    closeOwner: () => {
      alive = false;
    },
    polls: () => polls,
  };
}

test("dialog is opt-in, declares independent grants and has no other platform adapter", () => {
  const registry = new NativeRegistry([
    dialog._definition,
  ]);
  expect(
    [
      ...registry.operations.keys(),
    ].sort(),
  ).toEqual([
    "dialog.openFile",
    "dialog.saveFile",
    "dialog.selectFolder",
  ]);
  expect(Object.keys(dialog._definition.nativePlatforms)).toEqual([
    "windows",
  ]);
  expect(
    registry.allowed(
      {
        permissions: [
          "dialog.openFile",
        ],
      },
      registry.validateCall({
        operation: "dialog.openFile",
        payload: {},
      }),
    ),
  ).toBe(true);
});

test("validates inputs and permissions before allocating a picker", async () => {
  let allocations = 0;
  const f = fixture(() => {
    allocations++;
    return {
      show: () => ({
        cancelled: true,
      }),
      dispose() {},
    };
  });
  for (const input of [
    {
      title: "bad\0title",
    },
    {
      filters: [],
    },
    {
      filters: [
        {
          name: "Text",
          extensions: [
            "../txt",
          ],
        },
      ],
    },
    {
      defaultFileName: "a/b.txt",
    },
    {
      defaultExtension: ".txt",
    },
    {
      hwnd: 123,
    },
    {
      ownerWindowId: "",
    },
    {
      title: "x".repeat(257),
    },
  ]) {
    await expect(f.invoke("openFile", input)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  await expect(
    f.invoke("saveFile", {
      multiple: true,
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  await expect(
    f.invoke("selectFolder", {
      filters: [
        {
          name: "Text",
          extensions: [
            "txt",
          ],
        },
      ],
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  await expect(
    f.invoke("openFile", {}, "backend", undefined, [
      "dialog.saveFile",
    ]),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  expect(allocations).toBe(0);
  await f.adapter.dispose();
});

test("returns selected paths or explicit user cancellation and releases every picker", async () => {
  let releases = 0;
  const f = fixture((kind, input) => ({
    show: (owner) => {
      expect(owner).toBe(42n);
      expect(input.defaultDirectory).toBe("C:\\자료");
      return kind === "saveFile"
        ? {
            cancelled: true,
          }
        : {
            cancelled: false,
            paths: [
              "C:\\자료\\one.txt",
              "C:\\자료\\two.txt",
            ],
          };
    },
    dispose: () => {
      releases++;
    },
  }));
  await expect(
    f.invoke("openFile", {
      ownerWindowId: "owner",
      defaultDirectory: "C:\\자료",
      multiple: true,
      filters: [
        {
          name: "Text",
          extensions: [
            "txt",
            "md",
          ],
        },
      ],
    }),
  ).resolves.toEqual({
    cancelled: false,
    paths: [
      "C:\\자료\\one.txt",
      "C:\\자료\\two.txt",
    ],
  });
  await expect(
    f.invoke("saveFile", {
      ownerWindowId: "owner",
      defaultDirectory: "C:\\자료",
      defaultFileName: "memo",
      defaultExtension: "txt",
    }),
  ).resolves.toEqual({
    cancelled: true,
  });
  expect(releases).toBe(2);
  expect(f.adapter.busy?.()).toBe(false);
  await f.adapter.dispose();
});

test("view calls are bound to their exact authenticated native window", async () => {
  const f = fixture(() => ({
    show: (owner) => {
      expect(owner).toBe(42n);
      return {
        cancelled: true,
      };
    },
    dispose() {},
  }));
  await expect(f.invoke("selectFolder", {}, "view:main")).resolves.toEqual({
    cancelled: true,
  });
  await expect(
    f.invoke(
      "openFile",
      {
        ownerWindowId: "other",
      },
      "view:main",
    ),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  await expect(f.invoke("openFile", {}, "view:other")).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  await expect(
    f.invoke("openFile", {
      ownerWindowId: "missing",
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  f.closeOwner();
  await expect(f.invoke("openFile", {}, "view:main")).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  await f.adapter.dispose();
});

test("call abort, shutdown and owner retirement remain failures, even after native success", async () => {
  for (const cause of [
    "abort",
    "shutdown",
    "owner",
  ] as const) {
    const controller = new AbortController();
    let releases = 0;
    const f = fixture(() => ({
      show: (_owner, poll) => {
        expect(f.adapter.busy?.()).toBe(true);
        if (cause === "abort") {
          controller.abort();
        }
        if (cause === "shutdown") {
          f.stop();
        }
        if (cause === "owner") {
          f.closeOwner();
        }
        expect(poll()).toBe(true);
        return {
          cancelled: false,
          paths: [
            "C:\\late.txt",
          ],
        };
      },
      dispose: () => {
        releases++;
      },
    }));
    await expect(
      f.invoke(
        "openFile",
        {
          ownerWindowId: "owner",
        },
        "backend",
        controller.signal,
      ),
    ).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(releases).toBe(1);
    expect(f.polls()).toBe(1);
    expect(f.adapter.busy?.()).toBe(false);
    await f.adapter.dispose();
  }
});

test("pre-abort allocates nothing; native failures clean up and allow a subsequent call", async () => {
  let allocations = 0;
  let releases = 0;
  const f = fixture(() => {
    allocations++;
    return {
      show: () => {
        if (allocations === 1) {
          throw new Error("native failure");
        }
        return {
          cancelled: true,
        };
      },
      dispose: () => {
        releases++;
      },
    };
  });
  await expect(
    f.invoke("openFile", {}, "backend", AbortSignal.abort()),
  ).rejects.toMatchObject({
    code: "CANCELLED",
  });
  expect(allocations).toBe(0);
  await expect(f.invoke("openFile")).rejects.toThrow("native failure");
  await expect(f.invoke("openFile")).resolves.toEqual({
    cancelled: true,
  });
  expect(releases).toBe(2);
  await f.adapter.dispose();
  await expect(f.invoke("openFile")).rejects.toMatchObject({
    code: "CANCELLED",
  });
});

test("native reentry is BUSY and missing UI services are UNSUPPORTED", () => {
  const f = fixture();
  const state = new WindowsDialogs(f.services, () => ({
    show: () => {
      expect(() => state.show("openFile", {}, "backend")).toThrow(
        expect.objectContaining({
          code: "BUSY",
        }),
      );
      state.dispose();
      return {
        cancelled: true,
      };
    },
    dispose() {},
  }));
  expect(() => state.show("openFile", {}, "backend")).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
  expect(() =>
    new WindowsDialogs(undefined).show("openFile", {}, "backend"),
  ).toThrow(
    expect.objectContaining({
      code: "UNSUPPORTED",
    }),
  );
});

const REJECTED_CLOSE = -2147467259;
const HRESULT_CANCELLED_SIGNED = 0x800704c7 | 0;

test("an accepted Close supersedes earlier rejected Close attempts", () => {
  const laterAccepted = new DialogCloseRequest();
  expect(laterAccepted.record(REJECTED_CLOSE)).toBe(false);
  expect(laterAccepted.record(0)).toBe(true);
  expect(laterAccepted.settle(0)).toEqual({
    cancelled: true,
  });

  const laterRejected = new DialogCloseRequest();
  expect(laterRejected.record(0)).toBe(true);
  expect(laterRejected.record(REJECTED_CLOSE)).toBe(false);
  expect(laterRejected.settle(0)).toEqual({
    cancelled: true,
  });
});

test("an unsuperseded Close rejection fails and Show HRESULT decides otherwise", () => {
  const rejected = new DialogCloseRequest();
  rejected.record(REJECTED_CLOSE);
  let failure: unknown;
  try {
    rejected.settle(0);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(BunawayError);
  expect(failure).toMatchObject({
    code: "INTERNAL",
    details: {
      hresult: REJECTED_CLOSE >>> 0,
    },
  });

  const untouched = new DialogCloseRequest();
  expect(untouched.settle(HRESULT_CANCELLED_SIGNED)).toEqual({
    cancelled: true,
  });
  expect(untouched.settle(0)).toBeUndefined();
});
