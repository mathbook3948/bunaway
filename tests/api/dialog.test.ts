import { expect, test } from "bun:test";
import { defineNativePlugin, type NativeEnvironment } from "@bunaway/plugin";
import type { NativeDialogServices } from "@bunaway/plugin-api/native";
import dialog from "@bunaway/plugin-dialog";
import {
  BunawayError,
  type JsonValue,
  NativeRegistry,
} from "@bunaway/protocol";
import type { MessageResult } from "#plugins/dialog/src/contract";
import { dialogOperations } from "#plugins/dialog/src/operations";
import {
  type DialogFactory,
  type MessageDialogFactory,
  WindowsDialogs,
} from "#plugins/dialog/src/platforms/windows";
import { DialogCloseRequest } from "#plugins/dialog/src/platforms/windows-bindings";
import {
  encodeTaskDialogConfig,
  messageButtonIndex,
  TASKDIALOG_BUTTON_SIZE,
  TASKDIALOGCONFIG_SIZE,
} from "#plugins/dialog/src/platforms/windows-message-bindings";
import { nativeFactory } from "../fixtures/native-platform.ts";

function fixture(
  create: DialogFactory = () => ({
    show: () => ({
      cancelled: true,
    }),
    dispose() {},
  }),
  createMessage: MessageDialogFactory = () => ({
    show: () => ({
      button: 0,
      checkboxChecked: false,
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
          new WindowsDialogs(environment.dialogs, create, createMessage),
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
    "dialog.showMessage",
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

const messageResult: MessageResult = {
  button: 1,
  checkboxChecked: true,
};
const showMessageDriver = (
  show: (owner: bigint, poll: () => boolean) => MessageResult = () =>
    messageResult,
  onDispose: () => void = () => {},
): MessageDialogFactory => {
  return () => ({
    show,
    dispose: onDispose,
  });
};

test("showMessage validates input before allocating a driver", async () => {
  let allocations = 0;
  const f = fixture(undefined, () => {
    allocations++;
    return {
      show: () => messageResult,
      dispose() {},
    };
  });
  for (const input of [
    {},
    {
      message: "",
    },
    {
      message: "bad\0text",
    },
    {
      message: "x".repeat(4097),
    },
    {
      message: "ok",
      detail: "x".repeat(8193),
    },
    {
      message: "ok",
      buttons: [],
    },
    {
      message: "ok",
      buttons: Array.from(
        {
          length: 9,
        },
        (_, index) => `b${index}`,
      ),
    },
    {
      message: "ok",
      buttons: [
        "x".repeat(65),
      ],
    },
    {
      message: "ok",
      buttons: [
        "a",
        "b",
      ],
      defaultButton: 2,
    },
    {
      message: "ok",
      buttons: [
        "a",
        "b",
      ],
      cancelButton: 2,
    },
    {
      message: "ok",
      defaultButton: 1,
    },
    {
      message: "ok",
      cancelButton: 1,
    },
    {
      message: "ok",
      cancelButton: -1,
    },
    {
      message: "ok",
      type: "fatal",
    },
    {
      message: "ok",
      defaultDirectory: "C:\\",
    },
    {
      message: "ok",
      checkbox: {},
    },
    {
      message: "ok",
      checkbox: {
        label: "",
      },
    },
    {
      message: "ok",
      checkbox: {
        label: "x",
        checked: "yes",
      },
    },
  ]) {
    await expect(f.invoke("showMessage", input)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  expect(allocations).toBe(0);
  await f.adapter.dispose();
});

test("showMessage needs its own grant and passes the button result through", async () => {
  let releases = 0;
  const f = fixture(
    undefined,
    showMessageDriver(
      (owner) => {
        expect(owner).toBe(42n);
        return messageResult;
      },
      () => {
        releases++;
      },
    ),
  );
  await expect(
    f.invoke(
      "showMessage",
      {
        message: "Delete?",
      },
      "backend",
      undefined,
      [
        "dialog.openFile",
      ],
    ),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  await expect(
    f.invoke("showMessage", {
      ownerWindowId: "owner",
      message: "Delete?",
      detail: "This cannot be undone.",
      type: "warning",
      buttons: [
        "Keep",
        "Delete",
      ],
      defaultButton: 1,
      cancelButton: 0,
      checkbox: {
        label: "Do not ask again",
        checked: false,
      },
    }),
  ).resolves.toEqual(messageResult);
  expect(releases).toBe(1);
  expect(f.adapter.busy?.()).toBe(false);
  await f.adapter.dispose();
});

test("showMessage binds views to their window and rejects retired owners", async () => {
  const f = fixture(undefined, showMessageDriver());
  await expect(
    f.invoke(
      "showMessage",
      {
        message: "Hi",
      },
      "view:main",
    ),
  ).resolves.toEqual(messageResult);
  await expect(
    f.invoke(
      "showMessage",
      {
        message: "Hi",
        ownerWindowId: "other",
      },
      "view:main",
    ),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  f.closeOwner();
  await expect(
    f.invoke(
      "showMessage",
      {
        message: "Hi",
      },
      "view:main",
    ),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  await f.adapter.dispose();
});

test("showMessage abort, shutdown and owner retirement stay CANCELLED after native success", async () => {
  for (const cause of [
    "abort",
    "shutdown",
    "owner",
  ] as const) {
    const controller = new AbortController();
    let releases = 0;
    const f = fixture(
      undefined,
      showMessageDriver(
        (_owner, poll) => {
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
          return messageResult;
        },
        () => {
          releases++;
        },
      ),
    );
    await expect(
      f.invoke(
        "showMessage",
        {
          ownerWindowId: "owner",
          message: "Hi",
        },
        "backend",
        controller.signal,
      ),
    ).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(releases).toBe(1);
    expect(f.adapter.busy?.()).toBe(false);
    await f.adapter.dispose();
  }
});

test("native reentry is BUSY across showMessage and file dialogs", () => {
  const f = fixture();
  const state = new WindowsDialogs(
    f.services,
    () => ({
      show: () => {
        expect(() =>
          state.showMessage(
            {
              message: "Hi",
            },
            "backend",
          ),
        ).toThrow(
          expect.objectContaining({
            code: "BUSY",
          }),
        );
        return {
          cancelled: true,
        };
      },
      dispose() {},
    }),
    () => ({
      show: () => {
        expect(() => state.show("openFile", {}, "backend")).toThrow(
          expect.objectContaining({
            code: "BUSY",
          }),
        );
        return messageResult;
      },
      dispose() {},
    }),
  );
  expect(state.show("openFile", {}, "backend")).toEqual({
    cancelled: true,
  });
  expect(
    state.showMessage(
      {
        message: "Hi",
      },
      "backend",
    ),
  ).toEqual(messageResult);
});

const IDOK = 1;
const IDCANCEL = 2;
const THREE_BUTTONS = 3;

test("messageButtonIndex maps native IDs to button indexes", () => {
  // Escape, title-bar close and Alt+F4 all report IDCANCEL.
  expect(messageButtonIndex(IDCANCEL, THREE_BUTTONS, 2)).toBe(2);
  expect(messageButtonIndex(IDCANCEL, undefined, undefined)).toBe(0);
  expect(messageButtonIndex(IDCANCEL, 1, undefined)).toBe(0);
  expect(messageButtonIndex(1001, THREE_BUTTONS, undefined)).toBe(1);
  expect(messageButtonIndex(IDOK, undefined, undefined)).toBe(0);
  for (const [id, count, cancel] of [
    [
      IDCANCEL,
      THREE_BUTTONS,
      undefined,
    ],
    [
      IDOK,
      THREE_BUTTONS,
      undefined,
    ],
    [
      1003,
      THREE_BUTTONS,
      undefined,
    ],
    [
      999,
      THREE_BUTTONS,
      undefined,
    ],
    [
      1000,
      undefined,
      undefined,
    ],
  ] as const) {
    expect(() => messageButtonIndex(id, count, cancel)).toThrow(
      expect.objectContaining({
        code: "INTERNAL",
      }),
    );
  }
});

const TDF_ALLOW_DIALOG_CANCELLATION = 0x8;
const TDF_VERIFICATION_FLAG_CHECKED = 0x100;
const TDF_CALLBACK_TIMER = 0x800;
const TDF_POSITION_RELATIVE_TO_WINDOW = 0x1000;
const TDF_USE_HICON_MAIN = 0x2;
const fakeNative = {
  owner: 0n,
  callback: 0x1234n,
  questionIcon: 0x5678n,
};
// Buffers are addressed by index so tests can see which pointers are present without native memory.
const fakeAddress = (() => {
  let next = 0x1000n;
  return () => {
    next += 0x10n;
    return next;
  };
})();

test("encodeTaskDialogConfig writes the packed x64 layout for the common OK button", () => {
  const { config, keepAlive } = encodeTaskDialogConfig(
    {
      message: "Saved",
    },
    fakeNative,
    fakeAddress,
  );
  expect(config.length).toBe(TASKDIALOGCONFIG_SIZE);
  expect(TASKDIALOGCONFIG_SIZE).toBe(160);
  expect(config.readUInt32LE(0)).toBe(160);
  expect(config.readBigUInt64LE(4)).toBe(0n);
  // A single button resolves cancel to 0, so Escape stays enabled.
  expect(config.readUInt32LE(20)).toBe(
    TDF_CALLBACK_TIMER | TDF_ALLOW_DIALOG_CANCELLATION,
  );
  expect(config.readUInt32LE(24)).toBe(1);
  expect(config.readBigUInt64LE(28)).toBe(0n);
  expect(config.readBigUInt64LE(36)).toBe(0n);
  expect(config.readBigUInt64LE(44)).not.toBe(0n);
  expect(config.readBigUInt64LE(52)).toBe(0n);
  expect(config.readUInt32LE(60)).toBe(0);
  expect(config.readBigUInt64LE(64)).toBe(0n);
  expect(config.readInt32LE(72)).toBe(IDOK);
  expect(config.readBigUInt64LE(92)).toBe(0n);
  expect(config.readBigUInt64LE(140)).toBe(0x1234n);
  expect(keepAlive.map((buffer) => buffer.toString("utf16le"))).toEqual([
    "Saved\0",
  ]);
});

test("encodeTaskDialogConfig encodes custom buttons, checkbox, owner and cancel policy", () => {
  const { config, keepAlive } = encodeTaskDialogConfig(
    {
      title: "Confirm",
      message: "Delete?",
      detail: "Gone.",
      buttons: [
        "Keep",
        "Delete",
        "Later",
      ],
      defaultButton: 1,
      checkbox: {
        label: "Remember",
        checked: true,
      },
    },
    {
      ...fakeNative,
      owner: 0x42n,
    },
    fakeAddress,
  );
  // Several buttons without cancelButton: closing is disabled.
  expect(config.readUInt32LE(20)).toBe(
    TDF_CALLBACK_TIMER |
      TDF_VERIFICATION_FLAG_CHECKED |
      TDF_POSITION_RELATIVE_TO_WINDOW,
  );
  expect(config.readBigUInt64LE(4)).toBe(0x42n);
  expect(config.readUInt32LE(24)).toBe(0);
  expect(config.readBigUInt64LE(28)).not.toBe(0n);
  expect(config.readBigUInt64LE(52)).not.toBe(0n);
  expect(config.readBigUInt64LE(92)).not.toBe(0n);
  expect(config.readUInt32LE(60)).toBe(THREE_BUTTONS);
  expect(config.readInt32LE(72)).toBe(1001);
  const buttons = keepAlive.find(
    (buffer) => buffer.length === THREE_BUTTONS * TASKDIALOG_BUTTON_SIZE,
  );
  expect(TASKDIALOG_BUTTON_SIZE).toBe(12);
  expect(buttons).toBeDefined();
  for (let index = 0; index < THREE_BUTTONS; index++) {
    expect(buttons?.readInt32LE(index * 12)).toBe(1000 + index);
    expect(buttons?.readBigUInt64LE(index * 12 + 4)).not.toBe(0n);
  }
  expect(config.readBigUInt64LE(64)).not.toBe(0n);
});

test("encodeTaskDialogConfig allows cancellation only when a cancel button resolves and maps icons", () => {
  const flagsOf = (input: Parameters<typeof encodeTaskDialogConfig>[0]) =>
    encodeTaskDialogConfig(input, fakeNative, fakeAddress).config;
  const two = [
    "A",
    "B",
  ];
  expect(
    flagsOf({
      message: "m",
      buttons: two,
      cancelButton: 1,
    }).readUInt32LE(20) & TDF_ALLOW_DIALOG_CANCELLATION,
  ).toBe(TDF_ALLOW_DIALOG_CANCELLATION);
  expect(
    flagsOf({
      message: "m",
      buttons: two,
    }).readUInt32LE(20) & TDF_ALLOW_DIALOG_CANCELLATION,
  ).toBe(0);
  expect(
    flagsOf({
      message: "m",
      buttons: [
        "A",
      ],
    }).readUInt32LE(20) & TDF_ALLOW_DIALOG_CANCELLATION,
  ).toBe(TDF_ALLOW_DIALOG_CANCELLATION);
  for (const [type, value] of [
    [
      "none",
      0n,
    ],
    [
      "info",
      0xfffdn,
    ],
    [
      "warning",
      0xffffn,
    ],
    [
      "error",
      0xfffen,
    ],
    [
      "question",
      0x5678n,
    ],
  ] as const) {
    const config = flagsOf({
      message: "m",
      type,
    });
    expect(config.readBigUInt64LE(36)).toBe(value);
    expect(config.readUInt32LE(20) & TDF_USE_HICON_MAIN).toBe(
      type === "question" ? TDF_USE_HICON_MAIN : 0,
    );
  }
});
