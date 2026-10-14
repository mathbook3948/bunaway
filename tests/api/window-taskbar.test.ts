import { expect, test } from "bun:test";
import { type CommandContext, command } from "@bunaway/backend";
import type {
  NativeWindow,
  NativeWindowServices,
} from "@bunaway/plugin-api/native";
import windows, {
  validateWindowCall,
  validateWindowOutput,
} from "@bunaway/plugin-windows";
import { type HostContext, NativeRegistry } from "@bunaway/protocol";
import { bindHostAPI } from "#core/host-api";
import { createOperations } from "#plugins/windows/src/platforms/windows";

const operation = "windows.setTaskbarProgress";
const target = {
  view: "main",
};

test("taskbar schemas require bounded progress only for determinate states", () => {
  for (const state of [
    "none",
    "indeterminate",
  ] as const) {
    expect(
      validateWindowCall({
        operation,
        payload: {
          ...target,
          state,
        },
      }).payload,
    ).toEqual({
      ...target,
      state,
    });
  }
  for (const state of [
    "normal",
    "paused",
    "error",
  ] as const) {
    for (const value of [
      0,
      0.25,
      1,
    ]) {
      expect(
        validateWindowCall({
          operation,
          payload: {
            ...target,
            state,
            value,
            windowId: "id-1",
          },
        }).payload,
      ).toEqual({
        ...target,
        state,
        value,
        windowId: "id-1",
      });
    }
  }
  for (const payload of [
    null,
    {},
    {
      ...target,
      state: "normal",
    },
    {
      ...target,
      state: "none",
      value: 0,
    },
    {
      ...target,
      state: "indeterminate",
      value: 1,
    },
    {
      ...target,
      state: "unknown",
    },
    {
      ...target,
      state: "paused",
      value: -0.01,
    },
    {
      ...target,
      state: "error",
      value: 1.01,
    },
    {
      ...target,
      state: "normal",
      value: "0.5",
    },
    {
      ...target,
      state: "normal",
      value: 0.5,
      extra: true,
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
  expect(windows._definition.nativePlatforms.macos?.operations).not.toContain(
    "setTaskbarProgress",
  );
});

function fixture() {
  const applied: unknown[] = [];
  let closed = false;
  let cancelled = false;
  const unused = () => {
    throw new Error("Unexpected native window control");
  };
  const native: NativeWindow = {
    getReadiness: unused,
    getSnapshot: unused,
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
    setTaskbarProgress: (progress) => applied.push(progress),
  };
  const services: NativeWindowServices = {
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
    cancelled: () => cancelled,
    now: Date.now,
    tick: async () => {},
  };
  const adapter = createOperations({
    windows: services,
    dataRoot: ".",
    capabilities: [],
  });
  const execute = adapter.executeUI;
  if (!execute) {
    throw new Error("Missing window UI adapter");
  }
  return {
    native,
    applied,
    close: () => {
      closed = true;
    },
    cancel: () => {
      cancelled = true;
    },
    invoke: (
      permissions: string[] = [
        operation,
      ],
      view = "main",
    ) =>
      execute(
        operation,
        {
          view,
          state: "paused",
          value: 0.25,
        },
        "backend",
        {
          requestId: "progress",
          permissions: {
            permissions,
          },
        },
      ),
  };
}

test("taskbar dispatch preserves independent authority, live targets and platform failures", async () => {
  const f = fixture();
  expect(await f.invoke()).toBeNull();
  expect(f.applied).toEqual([
    {
      ...target,
      state: "paused",
      value: 0.25,
    },
  ]);
  await expect(
    f.invoke([
      "windows.show",
    ]),
  ).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  await expect(f.invoke([], "unknown")).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  await expect(
    f.invoke(
      [
        operation,
      ],
      "unknown",
    ),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  delete f.native.setTaskbarProgress;
  await expect(f.invoke()).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  f.close();
  await expect(f.invoke()).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  const pending = fixture();
  pending.cancel();
  await expect(pending.invoke()).rejects.toMatchObject({
    code: "CANCELLED",
  });
  expect(pending.applied).toEqual([]);
  expect(f.applied).toHaveLength(1);
});

test("taskbar SDK helper preserves command context and forwards the exact operation", async () => {
  const signal = new AbortController().signal;
  const payload = {
    ...target,
    state: "error",
    value: 0.75,
  } as const;
  const source = "editor" as HostContext;
  let calls = 0;
  const context: CommandContext = {
    signal,
    state: {
      get: () => undefined,
      set() {},
      delete: () => false,
    },
    events: {
      async emit() {},
    },
    host: bindHostAPI(
      source,
      signal,
      async (actualSource, call) => {
        calls++;
        expect(actualSource).toBe(source);
        expect(call).toEqual({
          operation,
          payload,
        });
        return {
          kind: "result",
          payload: null,
        };
      },
      new NativeRegistry([
        windows._definition,
      ]),
    ),
  };
  await command({
    input: {
      const: null,
    },
    output: {
      const: null,
    },
    async handle() {
      expect(await windows.setTaskbarProgress(payload)).toBeNull();
      return null;
    },
  }).run(null, context);
  expect(calls).toBe(1);
});
