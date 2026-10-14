import { expect, test } from "bun:test";
import type {
  NativeWindow,
  NativeWindowServices,
} from "@bunaway/plugin-api/native";
import windows, { validateWindowCall } from "@bunaway/plugin-windows";
import { type JsonValue, NativeRegistry } from "@bunaway/protocol";
import { createOperations } from "#plugins/windows/src/platforms/windows";

function fixture() {
  const actions: boolean[] = [];
  let muted = false;
  const unused = (): never => {
    throw new Error("Unrelated native operation");
  };
  const native: NativeWindow = {
    audio: {
      getState: () => ({
        muted,
        playing: true,
      }),
      setMuted(value) {
        muted = value;
        actions.push(value);
      },
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
  let cancelled = false;
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
    cancelled: () => cancelled,
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
      "windows.getWebViewAudioState",
      "windows.setWebViewAudioMuted",
    ],
  };
  const invoke = (
    operation: "windows.getWebViewAudioState" | "windows.setWebViewAudioMuted",
    payload: JsonValue = {
      view: "main",
    },
    source = "backend",
  ) => {
    if (!adapter.executeUI) {
      throw new Error("Missing native adapter");
    }
    return adapter.executeUI(operation, payload, source, {
      requestId: "audio-test",
      permissions,
    });
  };
  return {
    native,
    actions,
    permissions,
    invoke,
    close: () => {
      closed = true;
    },
    cancel: () => {
      cancelled = true;
    },
  };
}

test("audio operations have individual grants and strict target/mute contracts", () => {
  const registry = new NativeRegistry([
    windows._definition,
  ]);
  expect(registry.operation("windows.getWebViewAudioState").name).toBe(
    "windows.getWebViewAudioState",
  );
  expect(registry.operation("windows.setWebViewAudioMuted").name).toBe(
    "windows.setWebViewAudioMuted",
  );
  for (const payload of [
    {
      view: "main",
    },
    {
      view: "main",
      muted: 1,
    },
    {
      view: "main",
      muted: true,
      autoplay: true,
    },
  ]) {
    expect(() =>
      validateWindowCall({
        operation: "windows.setWebViewAudioMuted",
        payload,
      }),
    ).toThrow();
  }
  expect(() =>
    validateWindowCall({
      operation: "windows.getWebViewAudioState",
      payload: {
        view: "main",
        muted: false,
      },
    }),
  ).toThrow();
});

test("mute dispatch preserves the independent native playing state and per-view calls", async () => {
  const f = fixture();
  expect(await f.invoke("windows.getWebViewAudioState")).toEqual({
    muted: false,
    playing: true,
  });
  expect(
    await f.invoke(
      "windows.setWebViewAudioMuted",
      {
        view: "main",
        muted: true,
      },
      "main",
    ),
  ).toBeNull();
  expect(
    await f.invoke(
      "windows.getWebViewAudioState",
      {
        view: "main",
      },
      "main",
    ),
  ).toEqual({
    muted: true,
    playing: true,
  });
  expect(
    await f.invoke("windows.setWebViewAudioMuted", {
      view: "main",
      muted: false,
    }),
  ).toBeNull();
  expect(f.actions).toEqual([
    true,
    false,
  ]);
});

test("denied, cancelled, closed and unsupported targets never dispatch audio controls", async () => {
  for (const operation of [
    "windows.getWebViewAudioState",
    "windows.setWebViewAudioMuted",
  ] as const) {
    const payload =
      operation === "windows.getWebViewAudioState"
        ? {
            view: "main",
          }
        : {
            view: "main",
            muted: true,
          };
    const denied = fixture();
    denied.permissions.permissions = [];
    await expect(denied.invoke(operation, payload)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(denied.actions).toEqual([]);
    const cancelled = fixture();
    cancelled.cancel();
    await expect(cancelled.invoke(operation, payload)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    const closed = fixture();
    closed.close();
    await expect(closed.invoke(operation, payload)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    const unsupported = fixture();
    delete unsupported.native.audio;
    await expect(unsupported.invoke(operation, payload)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  }
});
